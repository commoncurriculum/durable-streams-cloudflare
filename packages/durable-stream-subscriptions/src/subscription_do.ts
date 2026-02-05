/**
 * SubscriptionDO - A Durable Object that manages subscribers for a single stream.
 *
 * Each stream gets its own SubscriptionDO instance with its own SQLite database.
 * This eliminates the D1 bottleneck by making subscriber lookups local to each DO.
 *
 * Data flow:
 * - Subscribe: Worker routes to SubscriptionDO(streamId) → DO stores subscriber in local SQLite
 * - Publish: Worker routes to SubscriptionDO(streamId) → DO writes to core → local subscriber lookup → fanout
 */

import { fetchFromCore, type CoreClientEnv } from "./core-client";
import { createMetrics } from "./metrics";

export interface SubscriptionDOEnv extends CoreClientEnv {
  METRICS?: AnalyticsEngineDataset;
  SESSION_TTL_SECONDS?: string;
}

interface Subscriber {
  session_id: string;
  subscribed_at: number;
}

export class SubscriptionDO {
  private sql: SqlStorage;
  private env: SubscriptionDOEnv;
  private streamId: string | null = null;

  constructor(state: DurableObjectState, env: SubscriptionDOEnv) {
    this.sql = state.storage.sql;
    this.env = env;
    state.blockConcurrencyWhile(async () => this.initSchema());
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscribers (
        session_id TEXT PRIMARY KEY,
        subscribed_at INTEGER NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Extract stream ID from X-Stream-Id header (set by worker when routing)
    this.streamId = request.headers.get("X-Stream-Id");

    try {
      if (request.method === "POST" && path === "/subscribe") {
        return await this.handleSubscribe(request);
      }

      if (request.method === "DELETE" && path === "/unsubscribe") {
        return await this.handleUnsubscribe(request);
      }

      if (request.method === "POST" && path === "/publish") {
        return await this.handlePublish(request);
      }

      if (request.method === "GET" && path === "/subscribers") {
        return await this.handleGetSubscribers();
      }

      if (request.method === "DELETE" && path === "/subscriber") {
        // Used by cleanup to remove a specific subscriber
        return await this.handleRemoveSubscriber(request);
      }

      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("SubscriptionDO error:", err);
      return new Response(
        JSON.stringify({ error: "Internal error", details: String(err) }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  /**
   * Add a subscriber to this stream.
   */
  private async handleSubscribe(request: Request): Promise<Response> {
    const body = await request.json() as { sessionId: string };
    const { sessionId } = body;

    if (!sessionId) {
      return new Response(JSON.stringify({ error: "sessionId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const now = Date.now();

    // Upsert subscriber (ON CONFLICT DO NOTHING since we just want idempotent add)
    this.sql.exec(
      `INSERT INTO subscribers (session_id, subscribed_at)
       VALUES (?, ?)
       ON CONFLICT(session_id) DO NOTHING`,
      sessionId,
      now,
    );

    return new Response(
      JSON.stringify({
        sessionId,
        streamId: this.streamId,
        subscribedAt: now,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  /**
   * Remove a subscriber from this stream.
   */
  private async handleUnsubscribe(request: Request): Promise<Response> {
    const body = await request.json() as { sessionId: string };
    const { sessionId } = body;

    if (!sessionId) {
      return new Response(JSON.stringify({ error: "sessionId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    this.sql.exec(
      "DELETE FROM subscribers WHERE session_id = ?",
      sessionId,
    );

    return new Response(
      JSON.stringify({
        sessionId,
        streamId: this.streamId,
        unsubscribed: true,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  /**
   * Handle a publish request:
   * 1. Write to core stream (source of truth)
   * 2. Look up subscribers (LOCAL query - no D1!)
   * 3. Fan out to all subscriber session streams
   */
  private async handlePublish(request: Request): Promise<Response> {
    const start = Date.now();
    const metrics = createMetrics(this.env.METRICS);
    const contentType = request.headers.get("Content-Type") ?? "application/json";
    const payload = await request.arrayBuffer();

    // Pass through producer headers for deduplication
    const producerId = request.headers.get("Producer-Id");
    const producerEpoch = request.headers.get("Producer-Epoch");
    const producerSeq = request.headers.get("Producer-Seq");

    const headers: Record<string, string> = {
      "Content-Type": contentType,
    };

    if (producerId && producerEpoch && producerSeq) {
      headers["Producer-Id"] = producerId;
      headers["Producer-Epoch"] = producerEpoch;
      headers["Producer-Seq"] = producerSeq;
    }

    // 1. Write to source stream in core
    const writeResponse = await fetchFromCore(
      this.env,
      `/v1/stream/${this.streamId}`,
      {
        method: "POST",
        headers,
        body: payload,
      },
    );

    if (!writeResponse.ok) {
      const errorText = await writeResponse.text();
      metrics.publishError(this.streamId ?? "", `http_${writeResponse.status}`, Date.now() - start);
      return new Response(
        JSON.stringify({ error: "Failed to write to stream", details: errorText }),
        {
          status: writeResponse.status,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Get offset for fanout deduplication
    const sourceOffset = writeResponse.headers.get("X-Stream-Next-Offset");

    // Build producer headers for fanout (using source stream offset)
    let fanoutProducerHeaders: Record<string, string> | undefined;
    if (sourceOffset) {
      fanoutProducerHeaders = {
        "Producer-Id": `fanout:${this.streamId}`,
        "Producer-Epoch": "1",
        "Producer-Seq": sourceOffset,
      };
    }

    // 2. Get subscribers (LOCAL query - no D1!)
    const subscribers = this.getSubscribers();

    // 3. Fan out to all subscriber session streams
    let successCount = 0;
    let failureCount = 0;

    if (subscribers.length > 0) {
      const results = await Promise.allSettled(
        subscribers.map((sessionId) =>
          this.writeToSessionStream(sessionId, payload, contentType, fanoutProducerHeaders),
        ),
      );

      for (const result of results) {
        if (result.status === "fulfilled" && result.value.ok) {
          successCount++;
        } else {
          failureCount++;
        }
      }

      // Record fanout metrics
      const latencyMs = Date.now() - start;
      metrics.fanout(this.streamId ?? "", subscribers.length, successCount, failureCount, latencyMs);
    }

    // Record publish metric
    metrics.publish(this.streamId ?? "", subscribers.length, Date.now() - start);

    // Return response with fanout stats
    const responseHeaders = new Headers(writeResponse.headers);
    responseHeaders.set("X-Fanout-Count", subscribers.length.toString());
    responseHeaders.set("X-Fanout-Successes", successCount.toString());
    responseHeaders.set("X-Fanout-Failures", failureCount.toString());
    responseHeaders.set("Content-Type", "application/json");

    return new Response(writeResponse.body, {
      status: writeResponse.status,
      headers: responseHeaders,
    });
  }

  /**
   * Get all subscribers for this stream.
   */
  private async handleGetSubscribers(): Promise<Response> {
    const subscribers = this.getSubscribersWithTimestamps();

    return new Response(
      JSON.stringify({
        streamId: this.streamId,
        subscribers: subscribers.map((s) => ({
          sessionId: s.session_id,
          subscribedAt: s.subscribed_at,
        })),
        count: subscribers.length,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  /**
   * Remove a specific subscriber (used by cleanup).
   */
  private async handleRemoveSubscriber(request: Request): Promise<Response> {
    const body = await request.json() as { sessionId: string };
    const { sessionId } = body;

    if (!sessionId) {
      return new Response(JSON.stringify({ error: "sessionId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    this.sql.exec("DELETE FROM subscribers WHERE session_id = ?", sessionId);

    return new Response(
      JSON.stringify({ sessionId, removed: true }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  /**
   * Get all subscriber session IDs (synchronous local query).
   */
  private getSubscribers(): string[] {
    const cursor = this.sql.exec("SELECT session_id FROM subscribers");
    const results: string[] = [];
    for (const row of cursor) {
      results.push(row.session_id as string);
    }
    return results;
  }

  /**
   * Get subscribers with timestamps.
   */
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

  /**
   * Write to a session stream.
   */
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
