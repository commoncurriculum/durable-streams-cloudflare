/**
 * SubscriptionDO - A Durable Object that manages subscribers for a single stream.
 *
 * Each stream gets its own SubscriptionDO instance with its own SQLite database.
 * Subscriber lookups are local to each DO (no external database needed).
 *
 * Uses DO RPC — typed methods, no HTTP inside the DO.
 */

import { DurableObject } from "cloudflare:workers";
import { fetchFromCore, type CoreClientEnv } from "../client";
import { createMetrics } from "../metrics";
import { FANOUT_BATCH_SIZE } from "../constants";
import type { PublishParams, PublishResult, GetSubscribersResult } from "./types";

export interface SubscriptionDOEnv extends CoreClientEnv {
  METRICS?: AnalyticsEngineDataset;
}

interface Subscriber {
  session_id: string;
  subscribed_at: number;
}

export class SubscriptionDO extends DurableObject<SubscriptionDOEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: SubscriptionDOEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.initSchema());
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscribers (
        session_id TEXT PRIMARY KEY,
        subscribed_at INTEGER NOT NULL
      );
    `);
  }

  async addSubscriber(sessionId: string): Promise<void> {
    this.sql.exec(
      `INSERT INTO subscribers (session_id, subscribed_at)
       VALUES (?, ?)
       ON CONFLICT(session_id) DO NOTHING`,
      sessionId,
      Date.now(),
    );
  }

  async removeSubscriber(sessionId: string): Promise<void> {
    this.sql.exec("DELETE FROM subscribers WHERE session_id = ?", sessionId);
  }

  async getSubscribers(streamId: string): Promise<GetSubscribersResult> {
    const subscribers = this.getSubscribersWithTimestamps();
    return {
      streamId,
      subscribers: subscribers.map((s) => ({
        sessionId: s.session_id,
        subscribedAt: s.subscribed_at,
      })),
      count: subscribers.length,
    };
  }

  async publish(streamId: string, params: PublishParams): Promise<PublishResult> {
    const start = Date.now();
    const metrics = createMetrics(this.env.METRICS);

    const headers: Record<string, string> = {
      "Content-Type": params.contentType,
    };

    if (params.producerId && params.producerEpoch && params.producerSeq) {
      headers["Producer-Id"] = params.producerId;
      headers["Producer-Epoch"] = params.producerEpoch;
      headers["Producer-Seq"] = params.producerSeq;
    }

    // 1. Write to source stream in core
    const writeResponse = await fetchFromCore(
      this.env,
      `/v1/stream/${streamId}`,
      {
        method: "POST",
        headers,
        body: params.payload,
      },
    );

    if (!writeResponse.ok) {
      const errorText = await writeResponse.text();
      metrics.publishError(streamId, `http_${writeResponse.status}`, Date.now() - start);
      return {
        status: writeResponse.status,
        nextOffset: null,
        upToDate: null,
        streamClosed: null,
        body: JSON.stringify({ error: "Failed to write to stream", details: errorText }),
        fanoutCount: 0,
        fanoutSuccesses: 0,
        fanoutFailures: 0,
      };
    }

    // Get offset for fanout deduplication
    const sourceOffset = writeResponse.headers.get("X-Stream-Next-Offset");

    // Build producer headers for fanout (using source stream offset)
    let fanoutProducerHeaders: Record<string, string> | undefined;
    if (sourceOffset) {
      fanoutProducerHeaders = {
        "Producer-Id": `fanout:${streamId}`,
        "Producer-Epoch": "1",
        "Producer-Seq": sourceOffset,
      };
    }

    // 2. Get subscribers (local DO SQLite query)
    const subscribers = this.getSubscriberSessionIds();

    // 3. Fan out to all subscriber session streams
    let successCount = 0;
    let failureCount = 0;

    if (subscribers.length > 0) {
      const results: PromiseSettledResult<Response>[] = [];
      for (let i = 0; i < subscribers.length; i += FANOUT_BATCH_SIZE) {
        const batch = subscribers.slice(i, i + FANOUT_BATCH_SIZE);
        const batchResults = await Promise.allSettled(
          batch.map((sessionId) =>
            this.writeToSessionStream(sessionId, params.payload, params.contentType, fanoutProducerHeaders),
          ),
        );
        results.push(...batchResults);
      }

      const staleSessionIds: string[] = [];
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === "fulfilled") {
          if (result.value.ok) {
            successCount++;
          } else if (result.value.status === 404) {
            staleSessionIds.push(subscribers[i]);
            failureCount++;
          } else {
            failureCount++;
          }
        } else {
          failureCount++;
        }
      }

      // Remove stale subscribers (sync - SQLite is local)
      for (const sessionId of staleSessionIds) {
        this.sql.exec("DELETE FROM subscribers WHERE session_id = ?", sessionId);
      }

      // Record fanout metrics
      const latencyMs = Date.now() - start;
      metrics.fanout({ streamId, subscribers: subscribers.length, success: successCount, failures: failureCount, latencyMs });
    }

    // Record publish metric
    metrics.publish(streamId, subscribers.length, Date.now() - start);

    // Read body from write response
    const body = await writeResponse.text();

    return {
      status: writeResponse.status,
      nextOffset: writeResponse.headers.get("X-Stream-Next-Offset"),
      upToDate: writeResponse.headers.get("X-Stream-Up-To-Date"),
      streamClosed: writeResponse.headers.get("X-Stream-Closed"),
      body,
      fanoutCount: subscribers.length,
      fanoutSuccesses: successCount,
      fanoutFailures: failureCount,
    };
  }

  private getSubscriberSessionIds(): string[] {
    const cursor = this.sql.exec("SELECT session_id FROM subscribers");
    const results: string[] = [];
    for (const row of cursor) {
      results.push(row.session_id as string);
    }
    return results;
  }

  private getSubscribersWithTimestamps(): Subscriber[] {
    const cursor = this.sql.exec("SELECT session_id, subscribed_at FROM subscribers");
    const results: Subscriber[] = [];
    for (const row of cursor) {
      results.push({
        session_id: row.session_id as string,
        subscribed_at: row.subscribed_at as number,
      });
    }
    return results;
  }

  private async writeToSessionStream(
    sessionId: string,
    payload: ArrayBuffer,
    contentType: string,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const path = `/v1/stream/session:${sessionId}`;
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      ...extraHeaders,
    };

    return fetchFromCore(this.env, path, {
      method: "POST",
      headers,
      body: payload,
    });
  }
}
