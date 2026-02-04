import { errorResponse } from "../protocol/errors";
import { isJsonContentType } from "../protocol/headers";
import { emptyJsonArray } from "../protocol/json";
import type { Timing } from "../protocol/timing";
import { readFromMessages, readFromOffset, type ReadResult } from "../engine/stream";
import { readSegmentMessages } from "../storage/segments";
import type { StreamMeta, StreamStorage } from "../storage/storage";
import type { StreamEnv } from "../http/context";

const COALESCE_CACHE_MS = 25;

type ReadStats = { internalReads: number };

export class ReadPath {
  private inFlightReads = new Map<string, Promise<ReadResult>>();
  private recentReads = new Map<string, { result: ReadResult; expiresAt: number }>();
  private readStats: ReadStats = { internalReads: 0 };

  constructor(
    private env: StreamEnv,
    private storage: StreamStorage,
  ) {}

  getStats(): ReadStats {
    return this.readStats;
  }

  async readFromOffset(
    streamId: string,
    meta: StreamMeta,
    offset: number,
    maxChunkBytes: number,
    timing: Timing | null,
  ): Promise<ReadResult> {
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
  ): Promise<ReadResult> {
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
}
