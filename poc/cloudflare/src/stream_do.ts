import { errorResponse } from "./protocol/errors";
import { isExpired } from "./protocol/expiry";
import { decodeOffset } from "./protocol/offsets";
import { concatBuffers, toUint8Array } from "./protocol/encoding";
import { isJsonContentType } from "./protocol/headers";
import {
  R2_COMPACT_MIN_BYTES,
  R2_COMPACT_MIN_MESSAGES,
  R2_HOT_BYTES,
  R2_HOT_MESSAGES,
} from "./protocol/limits";
import { LongPollQueue } from "./live/long_poll";
import type { SseState } from "./live/types";
import { D1Storage } from "./storage/d1";
import { buildSegmentKey, decodeSegmentMessages, encodeSegmentMessages } from "./storage/segments";
import type { StreamMeta } from "./storage/storage";
import { routeRequest } from "./http/router";
import { readFromMessages, readFromOffset } from "./engine/stream";
import type { StreamContext, StreamEnv, ResolveOffsetResult } from "./http/context";

export type Env = StreamEnv;

export class StreamDO {
  private state: DurableObjectState;
  private env: Env;
  private storage: D1Storage;
  private longPoll = new LongPollQueue();
  private sseState: SseState = { clients: new Map(), nextId: 0 };
  private inFlightReads = new Map<string, ReturnType<typeof readFromOffset>>();
  private readStats = { internalReads: 0 };

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.storage = new D1Storage(env.DB);
  }

  async fetch(request: Request): Promise<Response> {
    if (this.env.DEBUG_COALESCE === "1" && request.headers.get("X-Debug-Coalesce") === "1") {
      return new Response(JSON.stringify(this.readStats), {
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

    if (this.env.DEBUG_TESTING === "1") {
      const debugAction = request.headers.get("X-Debug-Action");
      if (debugAction) {
        return await this.handleDebugAction(debugAction, streamId, request);
      }
    }

    const ctx: StreamContext = {
      state: this.state,
      env: this.env,
      storage: this.storage,
      longPoll: this.longPoll,
      sseState: this.sseState,
      getStream: this.getStream.bind(this),
      resolveOffset: this.resolveOffset.bind(this),
      readFromOffset: this.readFromOffset.bind(this),
      compactToR2: this.compactToR2.bind(this),
    };

    return routeRequest(ctx, streamId, request);
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

  private resolveOffset(meta: StreamMeta, offsetParam: string | null): ResolveOffsetResult {
    if (offsetParam === null || offsetParam === "-1") {
      return { offset: 0, isNow: false };
    }

    if (offsetParam === "now") {
      return { offset: meta.tail_offset, isNow: true };
    }

    const decoded = decodeOffset(offsetParam);
    if (decoded === null) {
      return { offset: 0, isNow: false, error: errorResponse(400, "invalid offset") };
    }

    if (decoded > meta.tail_offset) {
      return { offset: 0, isNow: false, error: errorResponse(400, "offset beyond tail") };
    }

    return { offset: decoded, isNow: false };
  }

  private async compactToR2(
    streamId: string,
    options?: { force?: boolean; retainOps?: boolean; flushToTail?: boolean },
  ): Promise<void> {
    if (!this.env.R2) return;
    const meta = await this.storage.getStream(streamId);
    if (!meta) return;

    const isJson = isJsonContentType(meta.content_type);
    const minSegment = isJson ? R2_COMPACT_MIN_MESSAGES : R2_COMPACT_MIN_BYTES;
    const hotWindow = options?.flushToTail ? 0 : isJson ? R2_HOT_MESSAGES : R2_HOT_BYTES;
    const deleteOps = this.env.R2_DELETE_OPS !== "0" && !options?.retainOps;

    const latest = await this.storage.getLatestSnapshot(streamId);
    const segmentStart = latest?.end_offset ?? 0;
    const hotCutoff = Math.max(0, meta.tail_offset - hotWindow);

    if (hotCutoff <= segmentStart) return;

    const ops = await this.storage.selectOpsRange(streamId, segmentStart, hotCutoff);
    if (ops.length === 0) return;
    if (ops[0].start_offset !== segmentStart) return;

    for (let i = 1; i < ops.length; i += 1) {
      if (ops[i].start_offset !== ops[i - 1].end_offset) {
        return;
      }
    }

    const segmentEnd = ops[ops.length - 1].end_offset;
    if (!options?.force && segmentEnd - segmentStart < minSegment) {
      return;
    }

    const messages = ops.map((chunk) => toUint8Array(chunk.body));
    const body = encodeSegmentMessages(messages);

    const key = buildSegmentKey(streamId, segmentStart, segmentEnd, Date.now());
    await this.env.R2.put(key, body, {
      httpMetadata: { contentType: meta.content_type },
    });

    await this.storage.insertSnapshot({
      streamId,
      r2Key: key,
      startOffset: segmentStart,
      endOffset: segmentEnd,
      contentType: meta.content_type,
      createdAt: Date.now(),
    });

    if (deleteOps) {
      await this.storage.deleteOpsThrough(streamId, segmentEnd);
    }
  }

  private async readFromOffset(
    streamId: string,
    meta: StreamMeta,
    offset: number,
    maxChunkBytes: number,
  ): ReturnType<typeof readFromOffset> {
    const key = this.readKey(streamId, meta, offset, maxChunkBytes);
    const existing = this.inFlightReads.get(key);
    if (existing) return await existing;

    const pending = this.readFromOffsetInternal(streamId, meta, offset, maxChunkBytes);
    this.inFlightReads.set(key, pending);

    try {
      return await pending;
    } finally {
      this.inFlightReads.delete(key);
    }
  }

  private readKey(
    streamId: string,
    meta: StreamMeta,
    offset: number,
    maxChunkBytes: number,
  ): string {
    return [streamId, meta.tail_offset, meta.closed, offset, maxChunkBytes].join(":");
  }

  private async readFromOffsetInternal(
    streamId: string,
    meta: StreamMeta,
    offset: number,
    maxChunkBytes: number,
  ): ReturnType<typeof readFromOffset> {
    this.readStats.internalReads += 1;
    if (!this.env.R2) {
      return await readFromOffset(this.storage, streamId, meta, offset, maxChunkBytes);
    }

    const snapshot = await this.storage.getSnapshotCoveringOffset(streamId, offset);
    if (!snapshot) {
      return await this.readFromOffsetFallback(streamId, meta, offset, maxChunkBytes);
    }

    if (offset < snapshot.start_offset || offset >= snapshot.end_offset) {
      return await this.readFromOffsetFallback(streamId, meta, offset, maxChunkBytes);
    }

    const object = await this.env.R2.get(snapshot.r2_key);
    if (!object) {
      return await this.readFromOffsetFallback(streamId, meta, offset, maxChunkBytes);
    }

    const buffer = new Uint8Array(await object.arrayBuffer());
    const decoded = decodeSegmentMessages(buffer);
    if (decoded.truncated) {
      return await this.readFromOffsetFallback(streamId, meta, offset, maxChunkBytes);
    }

    const isJson = isJsonContentType(snapshot.content_type);
    if (isJson) {
      let messages = decoded.messages;
      if (snapshot.end_offset < meta.tail_offset) {
        const tailOps = await this.storage.selectOpsFrom(streamId, snapshot.end_offset);
        if (tailOps.length > 0) {
          messages = messages.concat(tailOps.map((chunk) => toUint8Array(chunk.body)));
        }
      }
      return readFromMessages({
        messages,
        contentType: snapshot.content_type,
        offset,
        maxChunkBytes,
        tailOffset: meta.tail_offset,
        closed: meta.closed === 1,
        segmentStart: snapshot.start_offset,
      });
    }

    const segmentResult = readFromMessages({
      messages: decoded.messages,
      contentType: snapshot.content_type,
      offset,
      maxChunkBytes,
      tailOffset: meta.tail_offset,
      closed: meta.closed === 1,
      segmentStart: snapshot.start_offset,
    });

    if (
      !segmentResult.hasData ||
      segmentResult.upToDate ||
      segmentResult.body.byteLength >= maxChunkBytes
    ) {
      return segmentResult;
    }

    const remaining = maxChunkBytes - segmentResult.body.byteLength;
    const tailResult = await readFromOffset(
      this.storage,
      streamId,
      meta,
      segmentResult.nextOffset,
      remaining,
    );

    if (!tailResult.hasData || tailResult.error) return segmentResult;

    const combined = concatBuffers([
      new Uint8Array(segmentResult.body),
      new Uint8Array(tailResult.body),
    ]);

    return {
      body: combined,
      nextOffset: tailResult.nextOffset,
      upToDate: tailResult.upToDate,
      closedAtTail: tailResult.closedAtTail,
      hasData: true,
    };
  }

  private async readFromOffsetFallback(
    streamId: string,
    meta: StreamMeta,
    offset: number,
    maxChunkBytes: number,
  ): ReturnType<typeof readFromOffset> {
    const fallback = await readFromOffset(this.storage, streamId, meta, offset, maxChunkBytes);
    if (!fallback.hasData && offset < meta.tail_offset && !fallback.error) {
      return {
        ...fallback,
        error: errorResponse(500, "cold segment unavailable"),
      };
    }
    return fallback;
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
      await this.compactToR2(streamId, { force: true, retainOps: true, flushToTail: true });
      return new Response(null, { status: 204 });
    }

    if (action === "truncate-latest") {
      if (!this.env.R2) return errorResponse(400, "R2 unavailable");
      const snapshot = await this.storage.getLatestSnapshot(streamId);
      if (!snapshot) return errorResponse(404, "snapshot not found");
      const object = await this.env.R2.get(snapshot.r2_key);
      if (!object) return errorResponse(404, "snapshot object missing");
      const buffer = new Uint8Array(await object.arrayBuffer());
      if (buffer.byteLength <= 1) return errorResponse(400, "snapshot too small");
      const truncated = buffer.slice(0, buffer.byteLength - 1);
      await this.env.R2.put(snapshot.r2_key, truncated, {
        httpMetadata: { contentType: snapshot.content_type },
      });
      return new Response(null, { status: 204 });
    }

    return errorResponse(400, "unknown debug action");
  }
}
