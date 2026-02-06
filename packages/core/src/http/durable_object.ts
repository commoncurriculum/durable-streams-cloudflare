import { errorResponse } from "../protocol/errors";
import { isExpired } from "../protocol/expiry";
import { SEGMENT_MAX_BYTES_DEFAULT, SEGMENT_MAX_MESSAGES_DEFAULT } from "../protocol/limits";
import { LongPollQueue } from "./handlers/realtime";
import type { SseState } from "./handlers/realtime";
import { DoSqliteStorage } from "../storage/queries";
import type { StreamMeta } from "../storage/types";
import { routeRequest } from "./router";
import { Timing, attachTiming } from "../protocol/timing";
import type { StreamContext, StreamEnv } from "./router";
import { ReadPath } from "../stream/read/path";
import { rotateSegment } from "../stream/rotate";
import { encodeStreamOffset, encodeTailOffset, resolveOffsetParam } from "../stream/offsets";

export type Env = StreamEnv;

export class StreamDO {
  private state: DurableObjectState;
  private env: Env;
  private storage: DoSqliteStorage;
  private longPoll = new LongPollQueue();
  private sseState: SseState = { clients: new Map(), nextId: 0 };
  private readPath: ReadPath;
  private rotating = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.storage = new DoSqliteStorage(state.storage.sql);
    this.readPath = new ReadPath(env, this.storage);
    this.state.blockConcurrencyWhile(async () => {
      this.storage.initSchema();
    });
  }

  // #region docs-do-fetch
  async fetch(request: Request): Promise<Response> {
    const timingEnabled =
      this.env.DEBUG_TIMING === "1" || request.headers.get("X-Debug-Timing") === "1";
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

    const streamId = request.headers.get("X-Stream-Id");
    if (!streamId) {
      return errorResponse(400, "missing stream id");
    }
    // #endregion docs-do-fetch

    if (this.env.DEBUG_TESTING === "1") {
      const debugAction = request.headers.get("X-Debug-Action");
      if (debugAction) {
        return await this.handleDebugAction(debugAction, streamId, request);
      }
    }

    // #region docs-build-context
    const ctx: StreamContext = {
      state: this.state,
      env: this.env,
      storage: this.storage,
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
