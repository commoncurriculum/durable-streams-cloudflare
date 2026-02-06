import { DurableObject } from "cloudflare:workers";
import { errorResponse } from "../protocol/errors";
import { isExpired } from "../protocol/expiry";
import { SEGMENT_MAX_BYTES_DEFAULT, SEGMENT_MAX_MESSAGES_DEFAULT } from "../protocol/limits";
import { LongPollQueue } from "./handlers/realtime";
import type { SseState } from "./handlers/realtime";
import { DoSqliteStorage } from "../storage/queries";
import type { StreamMeta, ProducerState, SegmentRecord, OpsStats } from "../storage/types";
import { routeRequest } from "./router";
import { Timing, attachTiming } from "../protocol/timing";
import type { StreamContext, StreamEnv } from "./router";
import type { CacheMode } from "./router";
import { ReadPath } from "../stream/read/path";
import { rotateSegment } from "../stream/rotate";
import { encodeStreamOffset, encodeTailOffset, resolveOffsetParam } from "../stream/offsets";

export type StreamIntrospection = {
  meta: StreamMeta;
  ops: OpsStats;
  segments: SegmentRecord[];
  producers: ProducerState[];
  sseClientCount: number;
  longPollWaiterCount: number;
};

export class StreamDO extends DurableObject<StreamEnv> {
  private storage: DoSqliteStorage;
  private longPoll = new LongPollQueue();
  private sseState: SseState = { clients: new Map(), nextId: 0 };
  private readPath: ReadPath;
  private rotating = false;

  constructor(ctx: DurableObjectState, env: StreamEnv) {
    super(ctx, env);
    this.storage = new DoSqliteStorage(ctx.storage.sql);
    this.readPath = new ReadPath(env, this.storage);
    ctx.blockConcurrencyWhile(async () => {
      this.storage.initSchema();
    });
  }

  // #region docs-do-rpc
  async routeStreamRequest(
    streamId: string,
    cacheMode: CacheMode,
    sessionId: string | null,
    timingEnabled: boolean,
    request: Request,
  ): Promise<Response> {
    const timing = timingEnabled ? new Timing() : null;
    const doneTotal = timing?.start("do.total");

    if (this.env.DEBUG_COALESCE === "1" && request.headers.get("X-Debug-Coalesce") === "1") {
      return new Response(JSON.stringify(this.readPath.getStats()), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }

    if (this.env.DEBUG_TESTING === "1") {
      const debugAction = request.headers.get("X-Debug-Action");
      if (debugAction) {
        return await this.handleDebugAction(debugAction, streamId, request);
      }
    }
    // #endregion docs-do-rpc

    // #region docs-build-context
    const ctx: StreamContext = {
      state: this.ctx,
      env: this.env,
      storage: this.storage,
      cacheMode,
      sessionId,
      timing,
      longPoll: this.longPoll,
      sseState: this.sseState,
      getStream: this.getStream.bind(this),
      resolveOffset: (streamId, meta, offsetParam) =>
        resolveOffsetParam(this.storage, streamId, meta, offsetParam),
      encodeOffset: (streamId, meta, offset) =>
        encodeStreamOffset(this.storage, streamId, meta, offset),
      encodeTailOffset: (streamId, meta) => encodeTailOffset(this.storage, streamId, meta),
      readFromOffset: (streamId, meta, offset, maxChunkBytes) =>
        this.readPath.readFromOffset(streamId, meta, offset, maxChunkBytes, timing),
      rotateSegment: this.rotateSegment.bind(this),
    };

    const response = await routeRequest(ctx, streamId, request);
    doneTotal?.();
    return attachTiming(response, timing);
    // #endregion docs-build-context
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
    };
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
  }

  private async rotateSegment(
    streamId: string,
    options?: { force?: boolean; retainOps?: boolean },
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
    return Number.isFinite(parsed) && parsed > 0 ? parsed : SEGMENT_MAX_MESSAGES_DEFAULT;
  }

  private segmentMaxBytes(): number {
    const raw = this.env.SEGMENT_MAX_BYTES;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : SEGMENT_MAX_BYTES_DEFAULT;
  }

  private async handleDebugAction(
    action: string,
    streamId: string,
    request: Request,
  ): Promise<Response> {
    if (action === "producer-age") {
      const payload = await request.json().catch(() => null);
      if (!payload || typeof payload !== "object") {
        return errorResponse(400, "invalid producer-age payload");
      }
      const producerId =
        "producerId" in payload && typeof payload.producerId === "string"
          ? payload.producerId
          : null;
      const lastUpdated =
        "lastUpdated" in payload && typeof payload.lastUpdated === "number"
          ? payload.lastUpdated
          : null;
      if (!producerId || lastUpdated === null) {
        return errorResponse(400, "invalid producer-age payload");
      }

      const updated = await this.storage.updateProducerLastUpdated(
        streamId,
        producerId,
        lastUpdated,
      );
      if (!updated) return errorResponse(404, "producer not found");
      return new Response(null, { status: 204 });
    }

    if (action === "compact-retain") {
      await this.rotateSegment(streamId, { force: true, retainOps: true });
      return new Response(null, { status: 204 });
    }

    if (action === "compact") {
      await this.rotateSegment(streamId, { force: true });
      return new Response(null, { status: 204 });
    }

    if (action === "ops-count") {
      const stats = await this.storage.getOpsStatsFrom(streamId, 0);
      return new Response(JSON.stringify({ count: stats.messageCount }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "truncate-latest") {
      if (!this.env.R2) return errorResponse(400, "R2 unavailable");
      const segment = await this.storage.getLatestSegment(streamId);
      if (!segment) return errorResponse(404, "segment not found");
      const object = await this.env.R2.get(segment.r2_key);
      if (!object) return errorResponse(404, "segment object missing");
      const buffer = new Uint8Array(await object.arrayBuffer());
      if (buffer.byteLength <= 1) return errorResponse(400, "segment too small");
      const truncated = buffer.slice(0, buffer.byteLength - 1);
      await this.env.R2.put(segment.r2_key, truncated, {
        httpMetadata: { contentType: segment.content_type },
      });
      return new Response(null, { status: 204 });
    }

    return errorResponse(400, "unknown debug action");
  }
}
