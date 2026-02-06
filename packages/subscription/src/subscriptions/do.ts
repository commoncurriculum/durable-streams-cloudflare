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
import { fanoutToSubscribers } from "./fanout";
import { createMetrics } from "../metrics";
import { bufferToBase64 } from "../util/base64";
import { FANOUT_QUEUE_THRESHOLD, FANOUT_QUEUE_BATCH_SIZE } from "../constants";
import type { PublishParams, PublishResult, GetSubscribersResult, FanoutQueueMessage } from "./types";

export interface SubscriptionDOEnv extends CoreClientEnv {
  METRICS?: AnalyticsEngineDataset;
  FANOUT_QUEUE?: Queue<FanoutQueueMessage>;
  FANOUT_QUEUE_THRESHOLD?: string;
}

interface Subscriber {
  session_id: string;
  subscribed_at: number;
}

// #region synced-to-docs:do-overview
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
  // #endregion synced-to-docs:do-overview

  // #region synced-to-docs:add-subscriber
  async addSubscriber(sessionId: string): Promise<void> {
    this.sql.exec(
      `INSERT INTO subscribers (session_id, subscribed_at)
       VALUES (?, ?)
       ON CONFLICT(session_id) DO NOTHING`,
      sessionId,
      Date.now(),
    );
  }
  // #endregion synced-to-docs:add-subscriber

  async removeSubscriber(sessionId: string): Promise<void> {
    this.sql.exec("DELETE FROM subscribers WHERE session_id = ?", sessionId);
  }

  async removeSubscribers(sessionIds: string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      this.sql.exec("DELETE FROM subscribers WHERE session_id = ?", sessionId);
    }
  }

  // #region synced-to-docs:get-subscribers
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
  // #endregion synced-to-docs:get-subscribers

  // #region synced-to-docs:publish-to-source
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

    // #endregion synced-to-docs:publish-to-source

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
        fanoutMode: "inline",
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

    // #region synced-to-docs:fanout
    // 2. Get subscribers (local DO SQLite query)
    const subscribers = this.getSubscriberSessionIds();

    // 3. Fan out to all subscriber session streams
    let successCount = 0;
    let failureCount = 0;
    let fanoutMode: "inline" | "queued" = "inline";

    if (subscribers.length > 0) {
      const threshold = this.env.FANOUT_QUEUE_THRESHOLD
        ? parseInt(this.env.FANOUT_QUEUE_THRESHOLD, 10)
        : FANOUT_QUEUE_THRESHOLD;

      if (this.env.FANOUT_QUEUE && subscribers.length > threshold) {
        // Queued fanout — enqueue and return immediately
        try {
          await this.enqueueFanout(streamId, subscribers, params.payload, params.contentType, fanoutProducerHeaders);
          fanoutMode = "queued";
          metrics.fanoutQueued(streamId, subscribers.length, Date.now() - start);
        } catch (err) {
          // Fallback to inline on queue failure
          console.error("Queue enqueue failed, falling back to inline fanout:", err);
          const result = await fanoutToSubscribers(this.env, subscribers, params.payload, params.contentType, fanoutProducerHeaders);
          successCount = result.successes;
          failureCount = result.failures;
          this.removeStaleSubscribers(result.staleSessionIds);
        }
      } else {
        // Inline fanout
        const result = await fanoutToSubscribers(this.env, subscribers, params.payload, params.contentType, fanoutProducerHeaders);
        successCount = result.successes;
        failureCount = result.failures;
        // #endregion synced-to-docs:fanout

        // #region synced-to-docs:stale-cleanup
        this.removeStaleSubscribers(result.staleSessionIds);
        // #endregion synced-to-docs:stale-cleanup
      }

      // Record fanout metrics (only for inline — queued records its own)
      if (fanoutMode === "inline") {
        const latencyMs = Date.now() - start;
        metrics.fanout({ streamId, subscribers: subscribers.length, success: successCount, failures: failureCount, latencyMs });
      }
    }

    // Record publish metric
    metrics.publish(streamId, subscribers.length, Date.now() - start);

    // Read body from write response
    const body = await writeResponse.text();

    // #region synced-to-docs:publish-response
    return {
      status: writeResponse.status,
      nextOffset: writeResponse.headers.get("X-Stream-Next-Offset"),
      upToDate: writeResponse.headers.get("X-Stream-Up-To-Date"),
      streamClosed: writeResponse.headers.get("X-Stream-Closed"),
      body,
      fanoutCount: subscribers.length,
      fanoutSuccesses: successCount,
      fanoutFailures: failureCount,
      fanoutMode,
    };
  }
  // #endregion synced-to-docs:publish-response

  private async enqueueFanout(
    streamId: string,
    sessionIds: string[],
    payload: ArrayBuffer,
    contentType: string,
    producerHeaders?: Record<string, string>,
  ): Promise<void> {
    const queue = this.env.FANOUT_QUEUE!;
    const payloadBase64 = bufferToBase64(payload);

    const messages: { body: FanoutQueueMessage }[] = [];
    for (let i = 0; i < sessionIds.length; i += FANOUT_QUEUE_BATCH_SIZE) {
      const batch = sessionIds.slice(i, i + FANOUT_QUEUE_BATCH_SIZE);
      messages.push({
        body: {
          streamId,
          sessionIds: batch,
          payload: payloadBase64,
          contentType,
          producerHeaders,
        },
      });
    }

    // sendBatch has a 100-message limit — chunk if needed
    const SEND_BATCH_LIMIT = 100;
    for (let i = 0; i < messages.length; i += SEND_BATCH_LIMIT) {
      await queue.sendBatch(messages.slice(i, i + SEND_BATCH_LIMIT));
    }
  }

  private removeStaleSubscribers(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      this.sql.exec("DELETE FROM subscribers WHERE session_id = ?", sessionId);
    }
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
}
