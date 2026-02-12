import { Hono } from "hono";
import { DurableObject } from "cloudflare:workers";
import { logError } from "../../../log";
import { LongPollQueue } from "./realtime/handlers";
import type { SseState } from "./realtime/handlers";
import { StreamDoStorage } from "../../../storage";
import type { StreamMeta, ProducerState, SegmentRecord, OpsStats } from "../../../storage";
import { parseStreamPathFromUrl } from "../../shared/stream-path";

import type { StreamContext, StreamEnv } from "./types";
import { ReadPath } from "./read/path";
import { encodeStreamOffset, encodeTailOffset, resolveOffsetParam } from "./shared/stream-offsets";
import { createStreamHttp } from "./create/http";
import { handleDelete } from "./delete";
import { readStreamHttp, headStreamHttp } from "./read/http";
import { errorResponse, ErrorCode } from "../../shared/errors";
import { isExpired } from "../../shared/expiry";
import { SEGMENT_MAX_BYTES_DEFAULT, SEGMENT_MAX_MESSAGES_DEFAULT } from "../../shared/limits";
import { deleteStreamEntry } from "../../../storage/registry";
import { rotateSegment as rotateSegmentImpl } from "./shared/rotate";
import { logWarn } from "../../../log";
import { appendStream } from "./append";

type DoAppEnv = {
  Bindings: {
    streamId: string;
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
  private storage: StreamDoStorage;
  private longPoll = new LongPollQueue();
  private sseState: SseState = { clients: new Map(), nextId: 0 };
  private readPath: ReadPath;
  private rotating = false;
  private app: Hono<DoAppEnv>;

  constructor(ctx: DurableObjectState, env: StreamEnv) {
    super(ctx, env);
    this.storage = new StreamDoStorage(ctx.storage);
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
      if (this.env.DEBUG_COALESCE === "1" && c.req.raw.headers.get("X-Debug-Coalesce") === "1") {
        return c.json(this.readPath.getStats(), 200, {
          "Cache-Control": "no-store",
        });
      }
      return next();
    });

    // Build StreamContext for each request
    app.use("*", async (c, next) => {
      c.set("streamContext", {
        state: this.ctx,
        env: this.env,
        storage: this.storage,
        longPoll: this.longPoll,
        sseState: this.sseState,
        getStream: (sid) => this.getStream(sid),
        resolveOffset: (sid, meta, offsetParam) =>
          resolveOffsetParam(this.storage, sid, meta, offsetParam),
        encodeOffset: (sid, meta, offset) => encodeStreamOffset(this.storage, sid, meta, offset),
        encodeTailOffset: (sid, meta) => encodeTailOffset(this.storage, sid, meta),
        readFromOffset: (sid, meta, offset, maxChunkBytes) =>
          this.readPath.readFromOffset(sid, meta, offset, maxChunkBytes),
        rotateSegment: (sid, options) => this.rotateSegment(sid, options),
        getWebSockets: (tag) => this.ctx.getWebSockets(tag),
      });

      await next();
    });

    // Routes
    app.put("*", async (c) => {
      return createStreamHttp(c.var.streamContext, c.env.streamId, c.req.raw);
    });
    app.post("*", async (c) => {
      const { appendStreamHttp } = await import("./append/http");
      return appendStreamHttp(c.var.streamContext, c.env.streamId, c.req.raw);
    });
    app.get("*", async (c) => {
      if (c.req.method === "HEAD") {
        return headStreamHttp(c.var.streamContext, c.env.streamId);
      }
      return readStreamHttp(c.var.streamContext, c.env.streamId, c.req.raw, new URL(c.req.url));
    });
    app.delete("*", async (c) => {
      return handleDelete(c.var.streamContext, c.env.streamId);
    });

    app.onError((err, c) => {
      logError(
        { streamId: c.env.streamId, method: c.req.method },
        "unhandled error in route handler",
        err,
      );
      return errorResponse(
        500,
        ErrorCode.INTERNAL_ERROR,
        err instanceof Error ? err.message : "internal error",
      );
    });

    return app;
  }

  // WebSocket upgrade requests (RPC cannot serialize WebSocket responses)
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
    return this.routeStreamRequest(parsed.path, request);
  }

  // Private helper methods
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
              e,
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
    options?: { force?: boolean; retainOps?: boolean },
  ): Promise<void> {
    if (this.rotating) return;
    this.rotating = true;
    try {
      await rotateSegmentImpl({
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
    return Number.isFinite(parsed) && parsed > 0 ? parsed : SEGMENT_MAX_MESSAGES_DEFAULT;
  }

  private segmentMaxBytes(): number {
    const raw = this.env.SEGMENT_MAX_BYTES;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : SEGMENT_MAX_BYTES_DEFAULT;
  }

  async routeStreamRequest(streamId: string, request: Request): Promise<Response> {
    return this.app.fetch(request, { streamId });
  }

  // RPC methods (called by edge router, estuary, subscription)
  async getStreamMeta(streamId: string): Promise<StreamMeta | null> {
    return this.getStream(streamId);
  }

  async getIntrospection(streamId: string): Promise<StreamIntrospection | null> {
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

  async appendStreamRpc(streamId: string, payload: Uint8Array): Promise<{ tailOffset: number }> {
    // Direct RPC method for SubscriptionDO - no HTTP overhead
    const ctx: StreamContext = {
      state: this.ctx,
      env: this.env,
      storage: this.storage,
      longPoll: this.longPoll,
      sseState: this.sseState,
      getStream: (sid) => this.getStream(sid),
      resolveOffset: (sid, meta, offsetParam) =>
        resolveOffsetParam(this.storage, sid, meta, offsetParam),
      encodeOffset: (sid, meta, offset) => encodeStreamOffset(this.storage, sid, meta, offset),
      encodeTailOffset: (sid, meta) => encodeTailOffset(this.storage, sid, meta),
      readFromOffset: (sid, meta, offset, maxChunkBytes) =>
        this.readPath.readFromOffset(sid, meta, offset, maxChunkBytes),
      rotateSegment: (sid, options) => this.rotateSegment(sid, options),
      getWebSockets: (tag) => this.ctx.getWebSockets(tag),
    };

    // Call appendStream inside blockConcurrencyWhile with try/catch INSIDE
    // so the callback never rejects (which would break the DO's input gate).
    // Trampoline: catch inside BCW, re-throw outside.
    const outcome = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        const r = await appendStream(ctx, { streamId, payload });
        return { ok: true as const, tailOffset: r.newTailOffset };
      } catch (error) {
        return { ok: false as const, error };
      }
    });

    if (!outcome.ok) throw outcome.error;
    return { tailOffset: outcome.tailOffset };
  }

  // Hibernation API handlers
  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    // Reserved for future use
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
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
        logWarn({ component: "ws-metrics" }, "best-effort WS close metrics failed", e);
      }
    }
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    logError({ component: "ws-error" }, "WebSocket error", error);
    try {
      ws.close(1011, "internal error");
    } catch {
      /* already closed */
    }
  }

  // Test hooks (service binding only)
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
    lastUpdated: number,
  ): Promise<boolean> {
    return await this.storage.updateProducerLastUpdated(streamId, producerId, lastUpdated);
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
