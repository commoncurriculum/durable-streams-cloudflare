/**
 * SubscriptionDO - A Durable Object that manages subscribers for a single stream.
 *
 * Each stream gets its own SubscriptionDO instance with its own SQLite database.
 * Subscriber lookups are local to each DO (no external database needed).
 *
 * Uses DO RPC — typed methods, no HTTP inside the DO.
 */

import { DurableObject } from "cloudflare:workers";
import { fanoutToSubscribers } from "./fanout";
import { createMetrics } from "../metrics";
import { logError, logInfo, logWarn } from "../log";
import { bufferToBase64 } from "../util/base64";
import { postStream } from "../storage/streams";
import {
  FANOUT_QUEUE_THRESHOLD,
  FANOUT_QUEUE_BATCH_SIZE,
  MAX_INLINE_FANOUT,
  CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  CIRCUIT_BREAKER_RECOVERY_MS,
} from "../constants";
import type { BaseEnv } from "../http";
import type { PublishParams, PublishResult, GetSubscribersResult, FanoutQueueMessage } from "./types";

export interface SubscriptionDOEnv extends BaseEnv {
  FANOUT_QUEUE?: Queue<FanoutQueueMessage>;
  FANOUT_QUEUE_THRESHOLD?: string;
  MAX_INLINE_FANOUT?: string;
}

type CircuitState = "closed" | "open" | "half-open";

interface Subscriber {
  estuary_id: string;
  subscribed_at: number;
}

// #region synced-to-docs:do-overview
export class SubscriptionDO extends DurableObject<SubscriptionDOEnv> {
  private sql: SqlStorage;
  private nextFanoutSeq: number;

  // Circuit breaker for inline fanout — protects the publish path when
  // downstream estuary streams are slow or failing.
  private circuitState: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureTime = 0;

  constructor(ctx: DurableObjectState, env: SubscriptionDOEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.nextFanoutSeq = 0;
    ctx.blockConcurrencyWhile(async () => {
      this.initSchema();
      this.nextFanoutSeq = this.loadFanoutSeq();
    });
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscribers (
        estuary_id TEXT PRIMARY KEY,
        subscribed_at INTEGER NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS fanout_state (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);
  }

  private loadFanoutSeq(): number {
    const cursor = this.sql.exec("SELECT value FROM fanout_state WHERE key = 'next_seq'");
    for (const row of cursor) {
      return row.value as number;
    }
    return 0;
  }

  private persistFanoutSeq(seq: number): void {
    this.sql.exec(
      `INSERT INTO fanout_state (key, value) VALUES ('next_seq', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      seq,
    );
  }
  // #endregion synced-to-docs:do-overview

  // #region synced-to-docs:add-subscriber
  async addSubscriber(estuaryId: string): Promise<void> {
    this.sql.exec(
      `INSERT INTO subscribers (estuary_id, subscribed_at)
       VALUES (?, ?)
       ON CONFLICT(estuary_id) DO NOTHING`,
      estuaryId,
      Date.now(),
    );
  }
  // #endregion synced-to-docs:add-subscriber

  async removeSubscriber(estuaryId: string): Promise<void> {
    this.sql.exec("DELETE FROM subscribers WHERE estuary_id = ?", estuaryId);
  }

  async removeSubscribers(estuaryIds: string[]): Promise<void> {
    if (estuaryIds.length === 0) return;
    const placeholders = estuaryIds.map(() => "?").join(", ");
    this.sql.exec(`DELETE FROM subscribers WHERE estuary_id IN (${placeholders})`, ...estuaryIds);
  }

  // #region synced-to-docs:get-subscribers
  async getSubscribers(streamId: string): Promise<GetSubscribersResult> {
    const subscribers = this.getSubscribersWithTimestamps();
    return {
      streamId,
      subscribers: subscribers.map((s) => ({
        estuaryId: s.estuary_id,
        subscribedAt: s.subscribed_at,
      })),
      count: subscribers.length,
    };
  }
  // #endregion synced-to-docs:get-subscribers

  // #region synced-to-docs:publish-to-source
  async publish(projectId: string, streamId: string, params: PublishParams): Promise<PublishResult> {
    const start = Date.now();
    const metrics = createMetrics(this.env.METRICS);

    // 1. Write to source stream in core (project-scoped)
    const sourceDoKey = `${projectId}/${streamId}`;
    const producerHeaders = params.producerId && params.producerEpoch && params.producerSeq
      ? { producerId: params.producerId, producerEpoch: params.producerEpoch, producerSeq: params.producerSeq }
      : undefined;
    // Clone payload — ArrayBuffers are transferred across RPC boundaries,
    // so the source write would detach the buffer before fanout can use it.
    const fanoutPayload = params.payload.slice(0);
    const writeResult = await postStream(
      this.env as BaseEnv,
      sourceDoKey,
      params.payload,
      params.contentType,
      producerHeaders,
    );

    // #endregion synced-to-docs:publish-to-source

    if (!writeResult.ok) {
      metrics.publishError(streamId, `http_${writeResult.status}`, Date.now() - start);
      return {
        status: writeResult.status,
        nextOffset: null,
        upToDate: null,
        streamClosed: null,
        body: JSON.stringify({ error: "Failed to write to stream", details: writeResult.body }),
        fanoutCount: 0,
        fanoutSuccesses: 0,
        fanoutFailures: 0,
        fanoutMode: "inline",
      };
    }

    // Track fanout sequence for producer-based deduplication.
    // Each subscriber estuary stream gets writes from producer "fanout:<streamId>".
    // The sequence number must be a monotonically increasing integer (0, 1, 2, ...),
    // NOT the hex-encoded source offset.
    const fanoutSeq = this.nextFanoutSeq++;
    this.persistFanoutSeq(this.nextFanoutSeq);
    const fanoutProducerHeaders = {
      producerId: `fanout:${streamId}`,
      producerEpoch: "1",
      producerSeq: fanoutSeq.toString(),
    };

    // #region synced-to-docs:fanout
    // 2. Get subscribers (local DO SQLite query)
    const subscribers = this.getSubscriberEstuaryIds();

    // 3. Fan out to all subscriber estuary streams
    let successCount = 0;
    let failureCount = 0;
    let fanoutMode: "inline" | "queued" | "circuit-open" | "skipped" = "inline";

    if (subscribers.length > 0) {
      const thresholdParsed = this.env.FANOUT_QUEUE_THRESHOLD
        ? parseInt(this.env.FANOUT_QUEUE_THRESHOLD, 10)
        : undefined;
      const threshold = thresholdParsed !== undefined && Number.isFinite(thresholdParsed) && thresholdParsed > 0
        ? thresholdParsed
        : FANOUT_QUEUE_THRESHOLD;

      const maxInlineParsed = this.env.MAX_INLINE_FANOUT
        ? parseInt(this.env.MAX_INLINE_FANOUT, 10)
        : undefined;
      const maxInline = maxInlineParsed && Number.isFinite(maxInlineParsed) && maxInlineParsed > 0
        ? maxInlineParsed
        : MAX_INLINE_FANOUT;

      if (this.env.FANOUT_QUEUE && subscribers.length > threshold) {
        // Queued fanout — enqueue and return immediately
        try {
          await this.enqueueFanout(projectId, streamId, subscribers, fanoutPayload, params.contentType, fanoutProducerHeaders);
          fanoutMode = "queued";
          metrics.fanoutQueued(streamId, subscribers.length, Date.now() - start);
        } catch (err) {
          logError({ projectId, streamId, subscribers: subscribers.length, component: "fanout-queue" }, "queue enqueue failed, falling back to inline fanout", err);
          if (!this.shouldAttemptInlineFanout()) {
            fanoutMode = "circuit-open";
          } else if (subscribers.length > maxInline) {
            fanoutMode = "skipped";
          } else {
            const result = await fanoutToSubscribers(this.env, projectId, subscribers, fanoutPayload, params.contentType, fanoutProducerHeaders);
            successCount = result.successes;
            failureCount = result.failures;
            this.updateCircuitBreaker(result.successes, result.failures);
            this.removeStaleSubscribers(result.staleEstuaryIds);
          }
        }
      } else if (!this.shouldAttemptInlineFanout()) {
        // Circuit breaker is open — skip inline fanout entirely.
        // Source write already committed; never return an error here.
        fanoutMode = "circuit-open";
      } else if (subscribers.length > maxInline) {
        // Too many subscribers for inline fanout without a queue
        fanoutMode = "skipped";
        logWarn({ streamId, subscribers: subscribers.length, maxInline, component: "fanout" }, "inline fanout skipped: too many subscribers and no queue configured");
      } else {
        // Inline fanout
        const result = await fanoutToSubscribers(this.env, projectId, subscribers, fanoutPayload, params.contentType, fanoutProducerHeaders);
        successCount = result.successes;
        failureCount = result.failures;
        this.updateCircuitBreaker(result.successes, result.failures);
        // #endregion synced-to-docs:fanout

        // #region synced-to-docs:stale-cleanup
        this.removeStaleSubscribers(result.staleEstuaryIds);
        // #endregion synced-to-docs:stale-cleanup
      }

      // Record fanout metrics (only for inline — queued records its own)
      if (fanoutMode === "inline") {
        const latencyMs = Date.now() - start;
        metrics.fanout({ streamId, subscribers: subscribers.length, success: successCount, failures: failureCount, latencyMs });
        if (failureCount > 0) {
          logWarn({ streamId, subscribers: subscribers.length, successes: successCount, failures: failureCount, latencyMs, component: "fanout" }, "inline fanout completed with failures");
        }
      } else if (fanoutMode === "circuit-open") {
        logWarn({ streamId, subscribers: subscribers.length, component: "fanout" }, "fanout skipped: circuit breaker open");
      }
    }

    // Record publish metric
    metrics.publish(streamId, subscribers.length, Date.now() - start);

    // #region synced-to-docs:publish-response
    return {
      status: writeResult.status,
      nextOffset: writeResult.nextOffset,
      upToDate: writeResult.upToDate,
      streamClosed: writeResult.streamClosed,
      body: writeResult.body ?? "",
      fanoutCount: subscribers.length,
      fanoutSuccesses: successCount,
      fanoutFailures: failureCount,
      fanoutMode,
    };
  }
  // #endregion synced-to-docs:publish-response

  /**
   * Check circuit breaker state. Returns true if inline fanout should proceed.
   * Transitions open → half-open after the recovery window.
   */
  private shouldAttemptInlineFanout(): boolean {
    if (this.circuitState === "closed") return true;

    if (this.circuitState === "open") {
      if (Date.now() - this.lastFailureTime >= CIRCUIT_BREAKER_RECOVERY_MS) {
        this.circuitState = "half-open";
        return true;
      }
      return false;
    }

    // half-open: allow one attempt
    return true;
  }

  /**
   * Update circuit breaker state based on fanout results.
   */
  private updateCircuitBreaker(successes: number, failures: number): void {
    if (failures === 0) {
      // All succeeded — close circuit
      this.circuitState = "closed";
      this.consecutiveFailures = 0;
      return;
    }

    if (successes > 0 && this.circuitState === "half-open") {
      // Partial success in half-open — close circuit
      this.circuitState = "closed";
      this.consecutiveFailures = 0;
      return;
    }

    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.consecutiveFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
      this.circuitState = "open";
      logInfo({ consecutiveFailures: this.consecutiveFailures, component: "circuit-breaker" }, "circuit breaker opened");
    }
  }

  private async enqueueFanout(
    projectId: string,
    streamId: string,
    estuaryIds: string[],
    payload: ArrayBuffer,
    contentType: string,
    producerHeaders?: { producerId: string; producerEpoch: string; producerSeq: string },
  ): Promise<void> {
    const queue = this.env.FANOUT_QUEUE!;
    const payloadBase64 = bufferToBase64(payload);

    const messages: { body: FanoutQueueMessage }[] = [];
    for (let i = 0; i < estuaryIds.length; i += FANOUT_QUEUE_BATCH_SIZE) {
      const batch = estuaryIds.slice(i, i + FANOUT_QUEUE_BATCH_SIZE);
      messages.push({
        body: {
          projectId,
          streamId,
          estuaryIds: batch,
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

  private removeStaleSubscribers(estuaryIds: string[]): void {
    if (estuaryIds.length === 0) return;
    const placeholders = estuaryIds.map(() => "?").join(", ");
    this.sql.exec(`DELETE FROM subscribers WHERE estuary_id IN (${placeholders})`, ...estuaryIds);
  }

  private getSubscriberEstuaryIds(): string[] {
    const cursor = this.sql.exec("SELECT estuary_id FROM subscribers");
    const results: string[] = [];
    for (const row of cursor) {
      results.push(row.estuary_id as string);
    }
    return results;
  }

  private getSubscribersWithTimestamps(): Subscriber[] {
    const cursor = this.sql.exec("SELECT estuary_id, subscribed_at FROM subscribers");
    const results: Subscriber[] = [];
    for (const row of cursor) {
      results.push({
        estuary_id: row.estuary_id as string,
        subscribed_at: row.subscribed_at as number,
      });
    }
    return results;
  }
}
