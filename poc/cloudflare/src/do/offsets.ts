import { errorResponse } from "../protocol/errors";
import { decodeOffsetParts, encodeOffset } from "../protocol/offsets";
import type { ResolveOffsetResult } from "../http/context";
import type { StreamMeta, StreamStorage } from "../storage/storage";

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
  return encodeOffset(meta.tail_offset - meta.segment_start, meta.read_seq);
}

export async function resolveOffsetParam(
  storage: StreamStorage,
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

  const segment = await storage.getSegmentByReadSeq(streamId, readSeq);
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
