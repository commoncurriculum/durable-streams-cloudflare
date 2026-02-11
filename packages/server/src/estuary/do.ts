import { DurableObject } from "cloudflare:workers";
import { logError, logInfo } from "../log";
import type { SubscriptionDO } from "../subscriptions/do";
import type { StreamDO } from "../http/durable-object";

export interface EstuaryDOEnv {
  STREAMS: DurableObjectNamespace<StreamDO>;
  SUBSCRIPTION_DO: DurableObjectNamespace<SubscriptionDO>;
  METRICS?: AnalyticsEngineDataset;
}

export class EstuaryDO extends DurableObject<EstuaryDOEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: EstuaryDOEnv) {
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
    this.sql.exec("DROP TABLE IF EXISTS session_info");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS estuary_info (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        project TEXT NOT NULL,
        estuary_id TEXT NOT NULL
      );
    `);
  }

  async setExpiry(project: string, estuaryId: string, ttlSeconds: number): Promise<void> {
    this.sql.exec(
      `INSERT INTO estuary_info (id, project, estuary_id) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET project = excluded.project, estuary_id = excluded.estuary_id`,
      project,
      estuaryId,
    );
    await this.ctx.storage.setAlarm(Date.now() + ttlSeconds * 1000);
  }

  async alarm(): Promise<void> {
    const cursor = this.sql.exec("SELECT project, estuary_id FROM estuary_info WHERE id = 1");
    let row: { project: string; estuary_id: string } | undefined;
    for (const r of cursor) {
      row = { project: r.project as string, estuary_id: r.estuary_id as string };
    }
    if (!row) return;

    const { project, estuary_id: estuaryId } = row;
    logInfo({ estuaryId, project, component: "estuary-alarm" }, "estuary expired, cleaning up");

    // Remove this estuary from all SubscriptionDOs
    const streamIds = await this.getSubscriptions();
    const BATCH_SIZE = 20;
    for (let i = 0; i < streamIds.length; i += BATCH_SIZE) {
      const batch = streamIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (streamId) => {
          const doKey = `${project}/${streamId}`;
          const stub = this.env.SUBSCRIPTION_DO.get(this.env.SUBSCRIPTION_DO.idFromName(doKey));
          await stub.removeSubscriber(estuaryId);
        }),
      );
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === "rejected") {
          logError(
            { estuaryId, streamId: batch[j], project, component: "estuary-alarm" },
            "failed to remove subscription",
            (results[j] as PromiseRejectedResult).reason,
          );
        }
      }
    }

    // Delete the estuary stream via HTTP interface
    try {
      const doKey = `${project}/${estuaryId}`;
      const stub = this.env.STREAMS.get(this.env.STREAMS.idFromName(doKey));
      const deleteRequest = new Request(`https://do/v1/stream/${doKey}`, { method: "DELETE" });
      await stub.routeStreamRequest(doKey, false, deleteRequest);
    } catch (err) {
      logError({ estuaryId, project, component: "estuary-alarm" }, "failed to delete estuary stream", err);
    }

    // Clean up local state
    this.sql.exec("DELETE FROM subscriptions");
    this.sql.exec("DELETE FROM estuary_info");
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
