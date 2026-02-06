import { errorResponse } from "../../protocol/errors";
import { isJsonContentType } from "../../protocol/headers";
import type { Timing } from "../../protocol/timing";
import { readFromOffset } from "./from_offset";
import { readFromMessages } from "./from_messages";
import { getContentStrategy } from "../content_strategy";
import {
  emptyResult,
  errorResult,
  gapResult,
  type ReadResult,
} from "./result";
import { readSegmentMessages } from "../../storage/segments";
import type { SegmentRecord, StreamMeta, StreamStorage } from "../../storage/types";
import type { StreamEnv } from "../../http/router";

const COALESCE_CACHE_MS = 25;

type ReadStats = { internalReads: number };

// ============================================================================
// Storage tier discriminated union
// ============================================================================

type StorageTier =
  | { tier: "hot" }
  | { tier: "r2"; segment: SegmentRecord }
  | { tier: "gap"; closedAtTail: boolean }
  | { tier: "error"; response: Response };

// ============================================================================
// ReadPath class
// ============================================================================

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

    const tier = await this.resolveStorageTier(streamId, meta, offset, timing);

    switch (tier.tier) {
      case "hot":
        return this.readFromHotStorage(streamId, meta, offset, maxChunkBytes, timing);

      case "r2":
        return this.readFromR2Segment(tier.segment, meta, offset, maxChunkBytes, timing);

      case "gap":
        return gapResult(offset, tier.closedAtTail, "r2");

      case "error":
        return errorResult(offset, tier.response, "r2");
    }
  }

  // ============================================================================
  // Storage tier resolution
  // ============================================================================

  private async resolveStorageTier(
    streamId: string,
    meta: StreamMeta,
    offset: number,
    timing: Timing | null,
  ): Promise<StorageTier> {
    // Hot storage: no R2 configured or offset is in current segment
    if (!this.env.R2 || offset >= meta.segment_start) {
      return { tier: "hot" };
    }

    // Look up segment covering this offset
    const doneLookup = timing?.start("segment.lookup");
    const segment = await this.storage.getSegmentCoveringOffset(streamId, offset);
    doneLookup?.();

    if (!segment) {
      return this.handleMissingSegment(streamId, meta, offset, timing);
    }

    // Validate offset is within segment bounds
    if (offset < segment.start_offset || offset > segment.end_offset) {
      return { tier: "error", response: errorResponse(400, "invalid offset") };
    }

    // At segment end boundary - return gap
    if (offset === segment.end_offset) {
      const closedAtTail = meta.closed === 1 && offset === meta.tail_offset;
      return { tier: "gap", closedAtTail };
    }

    return { tier: "r2", segment };
  }

  private async handleMissingSegment(
    streamId: string,
    meta: StreamMeta,
    offset: number,
    timing: Timing | null,
  ): Promise<StorageTier> {
    // Check if there's a segment starting at this offset
    const doneStarting = timing?.start("segment.lookup.starting");
    const starting = await this.storage.getSegmentStartingAt(streamId, offset);
    doneStarting?.();

    if (starting) {
      const closedAtTail = meta.closed === 1 && offset === meta.tail_offset;
      return { tier: "gap", closedAtTail };
    }

    return { tier: "error", response: errorResponse(500, "segment unavailable") };
  }

  // ============================================================================
  // Storage tier readers
  // ============================================================================

  private async readFromHotStorage(
    streamId: string,
    meta: StreamMeta,
    offset: number,
    maxChunkBytes: number,
    timing: Timing | null,
  ): Promise<ReadResult> {
    const done = timing?.start("read.hot");
    const result = await readFromOffset(this.storage, streamId, meta, offset, maxChunkBytes);
    done?.();
    return { ...result, source: "hot" };
  }

  private async readFromR2Segment(
    segment: SegmentRecord,
    meta: StreamMeta,
    offset: number,
    maxChunkBytes: number,
    timing: Timing | null,
  ): Promise<ReadResult> {
    // Fetch from R2
    const doneR2 = timing?.start("r2.get");
    const object = await this.env.R2!.get(segment.r2_key);
    doneR2?.();

    if (!object || !object.body) {
      return errorResult(offset, errorResponse(500, "segment missing"), "r2");
    }

    // Decode segment messages
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
      return errorResult(offset, errorResponse(500, "segment truncated"), "r2");
    }

    // Handle empty messages
    if (decoded.messages.length === 0) {
      const strategy = getContentStrategy(segment.content_type);
      const upToDate = offset === meta.tail_offset;
      const closedAtTail = meta.closed === 1 && upToDate;
      return emptyResult(offset, { upToDate, closedAtTail, strategy, source: "r2" });
    }

    // Read from decoded messages
    const result = readFromMessages({
      messages: decoded.messages,
      contentType: segment.content_type,
      offset,
      maxChunkBytes,
      tailOffset: meta.tail_offset,
      closed: meta.closed === 1,
      segmentStart: decoded.segmentStart,
    });

    return { ...result, source: "r2" };
  }
}
