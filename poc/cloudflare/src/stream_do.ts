import { errorResponse } from "./protocol/errors";
import { isExpired } from "./protocol/expiry";
import { decodeOffsetParts, encodeOffset } from "./protocol/offsets";
import { toUint8Array } from "./protocol/encoding";
import { isJsonContentType } from "./protocol/headers";
import { SEGMENT_MAX_BYTES_DEFAULT, SEGMENT_MAX_MESSAGES_DEFAULT } from "./protocol/limits";
import { LongPollQueue } from "./live/long_poll";
import type { SseState } from "./live/types";
import { DoSqliteStorage } from "./storage/do_sqlite";
import { buildSegmentKey, encodeSegmentMessages, readSegmentMessages } from "./storage/segments";
import type { StreamMeta } from "./storage/storage";
import { routeRequest } from "./http/router";
import { readFromMessages, readFromOffset, type ReadResult } from "./engine/stream";
import { emptyJsonArray } from "./protocol/json";
import { Timing, attachTiming } from "./protocol/timing";
import type { StreamContext, StreamEnv, ResolveOffsetResult } from "./http/context";

export type Env = StreamEnv;

const COALESCE_CACHE_MS = 25;

export class StreamDO {
  private state: DurableObjectState;
  private env: Env;
  private storage: DoSqliteStorage;
  private longPoll = new LongPollQueue();
  private sseState: SseState = { clients: new Map(), nextId: 0 };
  private inFlightReads = new Map<string, ReturnType<typeof readFromOffset>>();
  private recentReads = new Map<string, { result: ReadResult; expiresAt: number }>();
  private readStats = { internalReads: 0 };
  private rotating = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.storage = new DoSqliteStorage(state.storage.sql);
    this.state.blockConcurrencyWhile(async () => {
      this.storage.initSchema();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const timingEnabled =
      this.env.DEBUG_TIMING === "1" || request.headers.get("X-Debug-Timing") === "1";
    const timing = timingEnabled ? new Timing() : null;
    const doneTotal = timing?.start("do.total");

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
      timing,
      longPoll: this.longPoll,
      sseState: this.sseState,
      getStream: this.getStream.bind(this),
      resolveOffset: this.resolveOffset.bind(this),
      encodeOffset: this.encodeOffset.bind(this),
      encodeTailOffset: this.encodeTailOffset.bind(this),
      readFromOffset: (streamId, meta, offset, maxChunkBytes) =>
        this.readFromOffset(streamId, meta, offset, maxChunkBytes, timing),
      rotateSegment: this.rotateSegment.bind(this),
    };

    const response = await routeRequest(ctx, streamId, request);
    doneTotal?.();
    return attachTiming(response, timing);
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

  private encodeTailOffset(meta: StreamMeta): string {
    return encodeOffset(meta.tail_offset - meta.segment_start, meta.read_seq);
  }

  private async resolveOffset(
    streamId: string,
    meta: StreamMeta,
    offsetParam: string | null,
  ): Promise<ResolveOffsetResult> {
    if (offsetParam === null) {
      return {
        offset: 0,
        error: errorResponse(400, "offset is required"),
      };
    }

    const decoded = decodeOffsetParts(offsetParam);
    if (!decoded) {
      return {
        offset: 0,
        error: errorResponse(400, "invalid offset"),
      };
    }

    const { readSeq, byteOffset } = decoded;
    if (readSeq > meta.read_seq) {
      return {
        offset: 0,
        error: errorResponse(400, "invalid offset"),
      };
    }

    if (readSeq === meta.read_seq) {
      const offset = meta.segment_start + byteOffset;
      if (offset > meta.tail_offset) {
        return {
          offset: 0,
          error: errorResponse(400, "offset beyond tail"),
        };
      }
      return { offset };
    }

    const segment = await this.storage.getSegmentByReadSeq(streamId, readSeq);
    if (!segment) {
      return {
        offset: 0,
        error: errorResponse(400, "invalid offset"),
      };
    }

    const offset = segment.start_offset + byteOffset;
    if (offset > segment.end_offset) {
      return {
        offset: 0,
        error: errorResponse(400, "invalid offset"),
      };
    }

    if (offset > meta.tail_offset) {
      return {
        offset: 0,
        error: errorResponse(400, "offset beyond tail"),
      };
    }

    return { offset };
  }

  private async encodeOffset(streamId: string, meta: StreamMeta, offset: number): Promise<string> {
    if (offset >= meta.segment_start) {
      return encodeOffset(offset - meta.segment_start, meta.read_seq);
    }

    const segment = await this.storage.getSegmentCoveringOffset(streamId, offset);
    if (segment) {
      return encodeOffset(offset - segment.start_offset, segment.read_seq);
    }

    const starting = await this.storage.getSegmentStartingAt(streamId, offset);
    if (starting) {
      return encodeOffset(0, starting.read_seq);
    }

    return encodeOffset(0, meta.read_seq);
  }

  private async rotateSegment(
    streamId: string,
    options?: { force?: boolean; retainOps?: boolean },
  ): Promise<void> {
    if (!this.env.R2) return;
    if (this.rotating) return;
    this.rotating = true;
    try {
      const meta = await this.storage.getStream(streamId);
      if (!meta) return;

      const segmentMaxMessages = this.segmentMaxMessages();
      const segmentMaxBytes = this.segmentMaxBytes();
      const shouldRotate =
        options?.force ||
        meta.segment_messages >= segmentMaxMessages ||
        meta.segment_bytes >= segmentMaxBytes;
      if (!shouldRotate) return;

      const deleteOps = this.env.R2_DELETE_OPS !== "0" && !options?.retainOps;

      const segmentStart = meta.segment_start;
      const segmentEnd = meta.tail_offset;

      if (segmentEnd <= segmentStart) return;

      const ops = await this.storage.selectOpsRange(streamId, segmentStart, segmentEnd);
      if (ops.length === 0) return;
      if (ops[0].start_offset !== segmentStart) return;

      for (let i = 1; i < ops.length; i += 1) {
        if (ops[i].start_offset !== ops[i - 1].end_offset) {
          return;
        }
      }

      const resolvedEnd = ops[ops.length - 1].end_offset;
      if (resolvedEnd !== segmentEnd) return;

      const now = Date.now();
      const messages = ops.map((chunk) => toUint8Array(chunk.body));
      const body = encodeSegmentMessages(messages);
      const sizeBytes = messages.reduce((sum, message) => sum + message.byteLength, 0);
      const messageCount = messages.length;

      const key = buildSegmentKey(streamId, meta.read_seq);
      await this.env.R2.put(key, body, {
        httpMetadata: { contentType: meta.content_type },
      });

      const expiresAt = meta.expires_at ?? null;
      await this.storage.insertSegment({
        streamId,
        r2Key: key,
        startOffset: segmentStart,
        endOffset: segmentEnd,
        readSeq: meta.read_seq,
        contentType: meta.content_type,
        createdAt: now,
        expiresAt,
        sizeBytes,
        messageCount,
      });

      const remainingStats = await this.storage.getOpsStatsFrom(streamId, segmentEnd);
      await this.storage.batch([
        this.storage.updateStreamStatement(
          streamId,
          ["read_seq = ?", "segment_start = ?", "segment_messages = ?", "segment_bytes = ?"],
          [meta.read_seq + 1, segmentEnd, remainingStats.messageCount, remainingStats.sizeBytes],
        ),
      ]);

      await this.recordAdminSegment(streamId, {
        readSeq: meta.read_seq,
        startOffset: segmentStart,
        endOffset: segmentEnd,
        r2Key: key,
        contentType: meta.content_type,
        createdAt: now,
        expiresAt,
        sizeBytes,
        messageCount,
      });

      if (deleteOps) {
        await this.storage.deleteOpsThrough(streamId, segmentEnd);
      }
    } finally {
      this.rotating = false;
    }
  }

  private async readFromOffset(
    streamId: string,
    meta: StreamMeta,
    offset: number,
    maxChunkBytes: number,
    timing: Timing | null,
  ): ReturnType<typeof readFromOffset> {
    const key = this.readKey(streamId, meta, offset, maxChunkBytes);
    const cached = this.recentReads.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.result;
    }

    const existing = this.inFlightReads.get(key);
    if (existing) return await existing;

    const pending = this.readFromOffsetInternal(streamId, meta, offset, maxChunkBytes, timing).then(
      (result) => {
        if (!result.error) {
          this.recentReads.set(key, { result, expiresAt: Date.now() + COALESCE_CACHE_MS });
        }
        return result;
      },
    );
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
    timing: Timing | null,
  ): ReturnType<typeof readFromOffset> {
    this.readStats.internalReads += 1;
    if (!this.env.R2 || offset >= meta.segment_start) {
      const done = timing?.start("read.hot");
      const result = await readFromOffset(this.storage, streamId, meta, offset, maxChunkBytes);
      done?.();
      return { ...result, source: "hot" };
    }

    const doneLookup = timing?.start("segment.lookup");
    const segment = await this.storage.getSegmentCoveringOffset(streamId, offset);
    doneLookup?.();
    if (!segment) {
      const doneStarting = timing?.start("segment.lookup.starting");
      const starting = await this.storage.getSegmentStartingAt(streamId, offset);
      doneStarting?.();
      if (starting) {
        const closedAtTail = meta.closed === 1 && offset === meta.tail_offset;
        return {
          body: new ArrayBuffer(0),
          nextOffset: offset,
          upToDate: false,
          closedAtTail,
          hasData: false,
          source: "r2",
        };
      }
      return {
        body: new ArrayBuffer(0),
        nextOffset: offset,
        upToDate: false,
        closedAtTail: false,
        hasData: false,
        source: "r2",
        error: errorResponse(500, "segment unavailable"),
      };
    }

    if (offset < segment.start_offset || offset > segment.end_offset) {
      return {
        body: new ArrayBuffer(0),
        nextOffset: offset,
        upToDate: false,
        closedAtTail: false,
        hasData: false,
        source: "r2",
        error: errorResponse(400, "invalid offset"),
      };
    }

    if (offset === segment.end_offset) {
      const closedAtTail = meta.closed === 1 && offset === meta.tail_offset;
      return {
        body: new ArrayBuffer(0),
        nextOffset: offset,
        upToDate: false,
        closedAtTail,
        hasData: false,
        source: "r2",
      };
    }

    const doneR2 = timing?.start("r2.get");
    const object = await this.env.R2.get(segment.r2_key);
    doneR2?.();
    if (!object || !object.body) {
      return {
        body: new ArrayBuffer(0),
        nextOffset: offset,
        upToDate: false,
        closedAtTail: false,
        hasData: false,
        source: "r2",
        error: errorResponse(500, "segment missing"),
      };
    }

    const isJson = isJsonContentType(segment.content_type);
    const doneDecode = timing?.start("r2.decode");
    const decoded = await readSegmentMessages({
      body: object.body,
      offset,
      segmentStart: segment.start_offset,
      maxChunkBytes,
      isJson,
    });
    doneDecode?.();

    if (decoded.truncated) {
      return {
        body: new ArrayBuffer(0),
        nextOffset: offset,
        upToDate: false,
        closedAtTail: false,
        hasData: false,
        source: "r2",
        error: errorResponse(500, "segment truncated"),
      };
    }

    if (decoded.messages.length === 0) {
      const closedAtTail = meta.closed === 1 && offset === meta.tail_offset;
      return {
        body: isJson ? emptyJsonArray() : new ArrayBuffer(0),
        nextOffset: offset,
        upToDate: offset === meta.tail_offset,
        closedAtTail,
        hasData: false,
        source: "r2",
      };
    }

    return {
      ...(await readFromMessages({
        messages: decoded.messages,
        contentType: segment.content_type,
        offset,
        maxChunkBytes,
        tailOffset: meta.tail_offset,
        closed: meta.closed === 1,
        segmentStart: decoded.segmentStart,
      })),
      source: "r2",
    };
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

  private recordAdminSegment(
    streamId: string,
    segment: {
      readSeq: number;
      startOffset: number;
      endOffset: number;
      r2Key: string;
      contentType: string;
      createdAt: number;
      expiresAt: number | null;
      sizeBytes: number;
      messageCount: number;
    },
  ): void {
    if (!this.env.ADMIN_DB) return;
    const db = this.env.ADMIN_DB;
    this.state.waitUntil(
      db
        .prepare(
          `
            INSERT INTO segments_admin (
              stream_id,
              read_seq,
              start_offset,
              end_offset,
              r2_key,
              content_type,
              created_at,
              expires_at,
              size_bytes,
              message_count
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .bind(
          streamId,
          segment.readSeq,
          segment.startOffset,
          segment.endOffset,
          segment.r2Key,
          segment.contentType,
          segment.createdAt,
          segment.expiresAt,
          segment.sizeBytes,
          segment.messageCount,
        )
        .run(),
    );
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
