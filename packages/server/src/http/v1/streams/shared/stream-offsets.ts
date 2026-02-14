import { errorResponse, ErrorCode } from "../../../shared/errors";
import { decodeOffsetParts, encodeOffset } from "./offsets";
import type { ResolveOffsetResult } from "../types";
import type { StreamMeta, StreamStorage } from "../../../../storage/stream-do";

// ============================================================================
// Offset encoding
// ============================================================================

export function encodeCurrentOffset(meta: StreamMeta): string {
  return encodeOffset(meta.tail_offset - meta.segment_start, meta.read_seq);
}

export async function encodeTailOffset(
  storage: StreamStorage,
  streamId: string,
  meta: StreamMeta,
): Promise<string> {
  if (meta.closed === 1 && meta.segment_start >= meta.tail_offset && meta.read_seq > 0) {
    const previous = await storage.getSegmentByReadSeq(streamId, meta.read_seq - 1);
    if (previous) {
      return encodeOffset(meta.tail_offset - previous.start_offset, previous.read_seq);
    }
  }
  return encodeCurrentOffset(meta);
}

export async function encodeStreamOffset(
  storage: StreamStorage,
  streamId: string,
  meta: StreamMeta,
  offset: number,
): Promise<string> {
  if (offset >= meta.segment_start) {
    return encodeOffset(offset - meta.segment_start, meta.read_seq);
  }

  const segment = await storage.getSegmentCoveringOffset(streamId, offset);
  if (segment) {
    return encodeOffset(offset - segment.start_offset, segment.read_seq);
  }

  const starting = await storage.getSegmentStartingAt(streamId, offset);
  if (starting) {
    return encodeOffset(0, starting.read_seq);
  }

  return encodeOffset(0, meta.read_seq);
}

// ============================================================================
// Offset resolution
// ============================================================================

export async function resolveOffsetParam(
  storage: StreamStorage,
  streamId: string,
  meta: StreamMeta,
  offsetParam: string | null,
): Promise<ResolveOffsetResult> {
  if (offsetParam === null) {
    return errorOffset(ErrorCode.OFFSET_REQUIRED, "offset is required");
  }

  const decoded = decodeOffsetParts(offsetParam);
  if (!decoded) {
    return errorOffset(ErrorCode.INVALID_OFFSET, "invalid offset");
  }

  const { readSeq, byteOffset } = decoded;

  if (readSeq > meta.read_seq) {
    return errorOffset(ErrorCode.INVALID_OFFSET, "invalid offset");
  }

  if (readSeq === meta.read_seq) {
    return resolveCurrentSegmentOffset(byteOffset, meta);
  }

  return resolveHistoricalSegmentOffset(storage, streamId, readSeq, byteOffset, meta);
}

// ============================================================================
// Helper functions
// ============================================================================

function resolveCurrentSegmentOffset(byteOffset: number, meta: StreamMeta): ResolveOffsetResult {
  const offset = meta.segment_start + byteOffset;

  if (offset > meta.tail_offset) {
    return errorOffset(ErrorCode.OFFSET_BEYOND_TAIL, "offset beyond tail");
  }

  return { offset };
}

async function resolveHistoricalSegmentOffset(
  storage: StreamStorage,
  streamId: string,
  readSeq: number,
  byteOffset: number,
  meta: StreamMeta,
): Promise<ResolveOffsetResult> {
  const segment = await storage.getSegmentByReadSeq(streamId, readSeq);

  if (!segment) {
    return errorOffset(ErrorCode.INVALID_OFFSET, "invalid offset");
  }

  const offset = segment.start_offset + byteOffset;

  if (offset > segment.end_offset) {
    return errorOffset(ErrorCode.INVALID_OFFSET, "invalid offset");
  }

  if (offset > meta.tail_offset) {
    return errorOffset(ErrorCode.OFFSET_BEYOND_TAIL, "offset beyond tail");
  }

  return { offset };
}

function errorOffset(code: ErrorCode, message: string): ResolveOffsetResult {
  return { offset: 0, error: errorResponse(400, code, message) };
}
