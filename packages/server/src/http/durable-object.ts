import { Hono } from "hono";
import { DurableObject } from "cloudflare:workers";
import { isExpired } from "./shared/expiry";
import {
  SEGMENT_MAX_BYTES_DEFAULT,
  SEGMENT_MAX_MESSAGES_DEFAULT,
} from "./shared/limits";
import { logWarn, logError } from "../log";
import { LongPollQueue } from "../http/v1/streams/realtime/handlers";
import type { SseState } from "../http/v1/streams/realtime/handlers";
import { DoSqliteStorage } from "../storage/queries";
import type {
  StreamMeta,
  ProducerState,
  SegmentRecord,
  OpsStats,
} from "../storage/types";
import { parseStreamPathFromUrl } from "./shared/stream-path";
import { Timing, attachTiming } from "./shared/timing";
import type { StreamContext, StreamEnv } from "../http/v1/streams/types";
import { ReadPath } from "../http/v1/streams/read/path";
import { rotateSegment } from "../http/v1/streams/shared/rotate";
import {
  encodeStreamOffset,
  encodeTailOffset,
  resolveOffsetParam,
} from "../http/v1/streams/shared/stream-offsets";
import { deleteStreamEntry } from "../storage/registry";
import { handlePut } from "./v1/streams/create";
import { handlePost } from "./v1/streams/append";
import { handleDelete } from "./v1/streams/delete";
import { handleGet, handleHead } from "./v1/streams/read";
import { errorResponse } from "./shared/errors";

// ============================================================================
// Types
// ============================================================================

type DoAppEnv = {
  Bindings: {
    streamId: string;
    timingEnabled: boolean;
  };
  Variables: {
    streamContext: StreamContext;
  };
};

export type StreamIntrospection = {
  meta: StreamMeta;
  ops: OpsStats;
  segments: SegmentRecord[];
  producers: ProducerState[];
  sseClientCount: number;
  longPollWaiterCount: number;
  wsClientCount: number;
};

export class StreamDO extends DurableObject<StreamEnv> {
  private storage: DoSqliteStorage;
  private longPoll = new LongPollQueue();
  private sseState: SseState = { clients: new Map(), nextId: 0 };
  private readPath: ReadPath;
  private rotating = false;
  private app: Hono<DoAppEnv>;

  constructor(ctx: DurableObjectState, env: StreamEnv) {
    super(ctx, env);
    this.storage = new DoSqliteStorage(ctx.storage.sql);
    this.readPath = new ReadPath(env, this.storage);
    this.app = this.createApp();
    ctx.blockConcurrencyWhile(async () => {
      this.storage.initSchema();
    });
  }

  private createApp(): Hono<DoAppEnv> {
    const app = new Hono<DoAppEnv>();

    // Debug coalesce stats endpoint
    app.use("*", async (c, next) => {
      if (
        this.env.DEBUG_COALESCE === "1" &&
        c.req.raw.headers.get("X-Debug-Coalesce") === "1"
      ) {
        return c.json(this.readPath.getStats(), 200, {
          "Cache-Control": "no-store",
        });
      }
      return next();
    });

    // #region docs-build-context
    // Build StreamContext and timing for each request
    app.use("*", async (c, next) => {
      const timing = c.env.timingEnabled ? new Timing() : null;
      const doneTotal = timing?.start("do.total");

      c.set("streamContext", {
        state: this.ctx,
        env: this.env,
        storage: this.storage,
        timing,
        longPoll: this.longPoll,
        sseState: this.sseState,
        getStream: this.getStream.bind(this),
        resolveOffset: (sid, meta, offsetParam) =>
          resolveOffsetParam(this.storage, sid, meta, offsetParam),
        encodeOffset: (sid, meta, offset) =>
          encodeStreamOffset(this.storage, sid, meta, offset),
        encodeTailOffset: (sid, meta) =>
          encodeTailOffset(this.storage, sid, meta),
        readFromOffset: (sid, meta, offset, maxChunkBytes) =>
          this.readPath.readFromOffset(sid, meta, offset, maxChunkBytes, timing),
        rotateSegment: this.rotateSegment.bind(this),
        getWebSockets: (tag?: string) => this.ctx.getWebSockets(tag),
      });

      await next();

      doneTotal?.();
      c.res = attachTiming(c.res, timing);
    });
    // #endregion docs-build-context

    // Routes
    app.put("*", (c) =>
      handlePut(c.var.streamContext, c.env.streamId, c.req.raw));
    app.post("*", (c) =>
      handlePost(c.var.streamContext, c.env.streamId, c.req.raw));
    // Hono's app.get() matches both GET and HEAD, so dispatch manually
    app.get("*", (c) => {
      if (c.req.method === "HEAD") {
        return handleHead(c.var.streamContext, c.env.streamId);
      }
      return handleGet(c.var.streamContext, c.env.streamId, c.req.raw, new URL(c.req.url));
    });
    app.delete("*", (c) =>
      handleDelete(c.var.streamContext, c.env.streamId));

    app.onError((err, c) => {
      logError(
        { streamId: c.env.streamId, method: c.req.method },
        "unhandled error in route handler",
        err
      );
      return errorResponse(
        500,
        err instanceof Error ? err.message : "internal error"
      );
    });

    return app;
  }

  // Handle WebSocket upgrade requests via fetch() — RPC cannot serialize WebSocket responses
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const live = url.searchParams.get("live");
    if (live !== "ws-internal") {
      return new Response("not found", { status: 404 });
    }
    const parsed = parseStreamPathFromUrl(url.pathname);
    if (!parsed) {
      return new Response("not found", { status: 404 });
    }
    return this.routeStreamRequest(parsed.path, false, request);
  }

  // #region docs-do-rpc
  async routeStreamRequest(
    streamId: string,
    timingEnabled: boolean,
    request: Request
  ): Promise<Response> {
    return this.app.fetch(request, { streamId, timingEnabled });
  }
  // #endregion docs-do-rpc

  async getIntrospection(
    streamId: string
  ): Promise<StreamIntrospection | null> {
    const meta = await this.storage.getStream(streamId);
    if (!meta) return null;

    const ops = await this.storage.getOpsStatsFrom(streamId, 0);
    const segments = await this.storage.listSegments(streamId);
    const producers = await this.storage.listProducers(streamId);

    return {
      meta,
      ops,
      segments,
      producers,
      sseClientCount: this.sseState.clients.size,
      longPollWaiterCount: this.longPoll.getWaiterCount(),
      wsClientCount: this.ctx.getWebSockets().length,
    };
  }

  // Direct RPC methods for internal use (estuary, subscription)
  // These bypass HTTP routing for in-worker DO-to-DO calls

  async headStream(streamId: string): Promise<StreamMeta | null> {
    return this.getStream(streamId);
  }

  async createOrTouchStream(
    streamId: string,
    contentType: string,
    body?: Uint8Array
  ): Promise<{ status: 200 | 201; meta: StreamMeta }> {
    const request = new Request("https://internal", {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: body ?? null,
    });
    const response = await handlePut(
      {
        state: this.ctx,
        env: this.env,
        storage: this.storage,
        timing: null,
        longPoll: this.longPoll,
        sseState: this.sseState,
        getStream: this.getStream.bind(this),
        resolveOffset: (sid, meta, offsetParam) =>
          resolveOffsetParam(this.storage, sid, meta, offsetParam),
        encodeOffset: (sid, meta, offset) =>
          encodeStreamOffset(this.storage, sid, meta, offset),
        encodeTailOffset: (sid, meta) =>
          encodeTailOffset(this.storage, sid, meta),
        readFromOffset: (sid, meta, offset, maxChunkBytes) =>
          this.readPath.readFromOffset(sid, meta, offset, maxChunkBytes, null),
        rotateSegment: this.rotateSegment.bind(this),
        getWebSockets: (tag?: string) => this.ctx.getWebSockets(tag),
      },
      streamId,
      request
    );

    const status = response.status as 200 | 201;
    const meta = await this.getStream(streamId);
    if (!meta) throw new Error("Stream creation failed");
    return { status, meta };
  }

  async appendToStream(
    streamId: string,
    payload: Uint8Array
  ): Promise<{ tailOffset: number }> {
    const meta = await this.getStream(streamId);
    if (!meta) throw new Error("Stream not found");
    if (meta.closed) throw new Error("Stream is closed");

    const request = new Request("https://internal", {
      method: "POST",
      headers: { "Content-Type": meta.content_type },
      body: payload,
    });

    const response = await handlePost(
      {
        state: this.ctx,
        env: this.env,
        storage: this.storage,
        timing: null,
        longPoll: this.longPoll,
        sseState: this.sseState,
        getStream: this.getStream.bind(this),
        resolveOffset: (sid, meta, offsetParam) =>
          resolveOffsetParam(this.storage, sid, meta, offsetParam),
        encodeOffset: (sid, meta, offset) =>
          encodeStreamOffset(this.storage, sid, meta, offset),
        encodeTailOffset: (sid, meta) =>
          encodeTailOffset(this.storage, sid, meta),
        readFromOffset: (sid, meta, offset, maxChunkBytes) =>
          this.readPath.readFromOffset(sid, meta, offset, maxChunkBytes, null),
        rotateSegment: this.rotateSegment.bind(this),
        getWebSockets: (tag?: string) => this.ctx.getWebSockets(tag),
      },
      streamId,
      request
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Append failed: ${text}`);
    }

    const updatedMeta = await this.getStream(streamId);
    return { tailOffset: updatedMeta?.tail_offset ?? meta.tail_offset };
  }

  async deleteStream(streamId: string): Promise<void> {
    const response = await handleDelete(
      {
        state: this.ctx,
        env: this.env,
        storage: this.storage,
        timing: null,
        longPoll: this.longPoll,
        sseState: this.sseState,
        getStream: this.getStream.bind(this),
        resolveOffset: (sid, meta, offsetParam) =>
          resolveOffsetParam(this.storage, sid, meta, offsetParam),
        encodeOffset: (sid, meta, offset) =>
          encodeStreamOffset(this.storage, sid, meta, offset),
        encodeTailOffset: (sid, meta) =>
          encodeTailOffset(this.storage, sid, meta),
        readFromOffset: (sid, meta, offset, maxChunkBytes) =>
          this.readPath.readFromOffset(sid, meta, offset, maxChunkBytes, null),
        rotateSegment: this.rotateSegment.bind(this),
        getWebSockets: (tag?: string) => this.ctx.getWebSockets(tag),
      },
      streamId
    );

    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      throw new Error(`Delete failed: ${text}`);
    }
  }

  private async getStream(streamId: string): Promise<StreamMeta | null> {
    const result = await this.storage.getStream(streamId);

    if (!result) return null;
    if (isExpired(result)) {
      await this.deleteStreamData(streamId);
      return null;
    }

    return result;
  }

  private async deleteStreamData(streamId: string): Promise<void> {
    await this.storage.deleteStreamData(streamId);
    // FIX-014: KV metadata cleanup with retry (max 3 attempts, backoff)
    if (this.env.REGISTRY) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await deleteStreamEntry(this.env.REGISTRY, streamId);
          return;
        } catch (e) {
          if (attempt === 3) {
            logWarn(
              { streamId, attempt, component: "kv-cleanup" },
              "KV delete failed after retries on expiry",
              e
            );
          } else {
            await new Promise((r) => setTimeout(r, attempt * 100));
          }
        }
      }
    }
  }

  private async rotateSegment(
    streamId: string,
    options?: { force?: boolean; retainOps?: boolean }
  ): Promise<void> {
    if (this.rotating) return;
    this.rotating = true;
    try {
      await rotateSegment({
        env: this.env,
        storage: this.storage,
        streamId,
        segmentMaxMessages: this.segmentMaxMessages(),
        segmentMaxBytes: this.segmentMaxBytes(),
        force: options?.force,
        retainOps: options?.retainOps,
      });
    } finally {
      this.rotating = false;
    }
  }

  private segmentMaxMessages(): number {
    const raw = this.env.SEGMENT_MAX_MESSAGES;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : SEGMENT_MAX_MESSAGES_DEFAULT;
  }

  private segmentMaxBytes(): number {
    const raw = this.env.SEGMENT_MAX_BYTES;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : SEGMENT_MAX_BYTES_DEFAULT;
  }

  // =========================================================================
  // Hibernation API event handlers (internal WebSocket bridge)
  // =========================================================================

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    // Internal bridge: edge worker doesn't send messages to the DO.
    // Reserved for future use (e.g., offset acknowledgements).
  }

  webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): void {
    // Connection closed — no cleanup needed beyond what Cloudflare does
    // automatically. The WebSocket is already removed from getWebSockets().
    if (this.env.METRICS) {
      try {
        const attachment = ws.deserializeAttachment() as {
          streamId?: string;
        } | null;
        const streamId = attachment?.streamId ?? "unknown";
        this.env.METRICS.writeDataPoint({
          indexes: [streamId],
          blobs: [streamId, "ws_disconnect", "anonymous"],
          doubles: [1, 0],
        });
      } catch (e) {
        logWarn(
          { component: "ws-metrics" },
          "best-effort WS close metrics failed",
          e
        );
      }
    }
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    logWarn({ component: "ws-error" }, "WebSocket error", error);
    try {
      ws.close(1011, "internal error");
    } catch {
      /* already closed */
    }
  }

  // RPC methods for test tooling (accessible only via service bindings, not HTTP)

  async testForceCompact(streamId: string, retainOps?: boolean): Promise<void> {
    await this.rotateSegment(streamId, {
      force: true,
      retainOps: retainOps ?? false,
    });
  }

  async testGetOpsCount(streamId: string): Promise<number> {
    const stats = await this.storage.getOpsStatsFrom(streamId, 0);
    return stats.messageCount;
  }

  async testSetProducerAge(
    streamId: string,
    producerId: string,
    lastUpdated: number
  ): Promise<boolean> {
    return await this.storage.updateProducerLastUpdated(
      streamId,
      producerId,
      lastUpdated
    );
  }

  async testTruncateLatestSegment(streamId: string): Promise<boolean> {
    if (!this.env.R2) return false;
    const segment = await this.storage.getLatestSegment(streamId);
    if (!segment) return false;
    const object = await this.env.R2.get(segment.r2_key);
    if (!object) return false;
    const buffer = new Uint8Array(await object.arrayBuffer());
    if (buffer.byteLength <= 1) return false;
    const truncated = buffer.slice(0, buffer.byteLength - 1);
    await this.env.R2.put(segment.r2_key, truncated, {
      httpMetadata: { contentType: segment.content_type },
    });
    return true;
  }
}
