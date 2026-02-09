import { DurableObject } from "cloudflare:workers";
import { logError, logInfo } from "../log";
import type { CoreService } from "../client";
import type { SubscriptionDO } from "../subscriptions/do";

export interface SessionDOEnv {
  SUBSCRIPTION_DO: DurableObjectNamespace<SubscriptionDO>;
  CORE: CoreService;
  METRICS?: AnalyticsEngineDataset;
}

export class SessionDO extends DurableObject<SessionDOEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: SessionDOEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.initSchema());
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        stream_id TEXT PRIMARY KEY,
        subscribed_at INTEGER NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_info (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        project TEXT NOT NULL,
        session_id TEXT NOT NULL
      );
    `);
  }

  async setExpiry(project: string, sessionId: string, ttlSeconds: number): Promise<void> {
    this.sql.exec(
      `INSERT INTO session_info (id, project, session_id) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET project = excluded.project, session_id = excluded.session_id`,
      project,
      sessionId,
    );
    await this.ctx.storage.setAlarm(Date.now() + ttlSeconds * 1000);
  }

  async alarm(): Promise<void> {
    const cursor = this.sql.exec("SELECT project, session_id FROM session_info WHERE id = 1");
    let row: { project: string; session_id: string } | undefined;
    for (const r of cursor) {
      row = { project: r.project as string, session_id: r.session_id as string };
    }
    if (!row) return;

    const { project, session_id: sessionId } = row;
    logInfo({ sessionId, project, component: "session-alarm" }, "session expired, cleaning up");

    // Remove this session from all SubscriptionDOs
    const streamIds = await this.getSubscriptions();
    const BATCH_SIZE = 20;
    for (let i = 0; i < streamIds.length; i += BATCH_SIZE) {
      const batch = streamIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (streamId) => {
          const doKey = `${project}/${streamId}`;
          const stub = this.env.SUBSCRIPTION_DO.get(this.env.SUBSCRIPTION_DO.idFromName(doKey));
          await stub.removeSubscriber(sessionId);
        }),
      );
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === "rejected") {
          logError(
            { sessionId, streamId: batch[j], project, component: "session-alarm" },
            "failed to remove subscription",
            (results[j] as PromiseRejectedResult).reason,
          );
        }
      }
    }

    // Delete the session stream from core
    try {
      const doKey = `${project}/${sessionId}`;
      const result = await this.env.CORE.deleteStream(doKey);
      if (!result.ok && result.status !== 404) {
        logError({ sessionId, project, status: result.status, component: "session-alarm" }, "failed to delete session stream");
      }
    } catch (err) {
      logError({ sessionId, project, component: "session-alarm" }, "failed to delete session stream (exception)", err);
    }

    // Clean up local state
    this.sql.exec("DELETE FROM subscriptions");
    this.sql.exec("DELETE FROM session_info");
  }

  async addSubscription(streamId: string): Promise<void> {
    this.sql.exec(
      `INSERT INTO subscriptions (stream_id, subscribed_at)
       VALUES (?, ?)
       ON CONFLICT(stream_id) DO NOTHING`,
      streamId,
      Date.now(),
    );
  }

  async removeSubscription(streamId: string): Promise<void> {
    this.sql.exec("DELETE FROM subscriptions WHERE stream_id = ?", streamId);
  }

  async getSubscriptions(): Promise<string[]> {
    const cursor = this.sql.exec("SELECT stream_id FROM subscriptions ORDER BY subscribed_at DESC");
    const results: string[] = [];
    for (const row of cursor) {
      results.push(row.stream_id as string);
    }
    return results;
  }
}
