import { isJsonContentType } from "../../http/shared/headers";
import { errorResponse } from "../../http/shared/errors";
import { buildJsonArray, emptyJsonArray } from "../../http/v1/streams/shared/json";
import { concatBuffers } from "../../http/v1/streams/shared/encoding";
import { emptyResult, errorResult, dataResult, type ReadResult } from "./read-result";

export function readFromMessages(params: {
  messages: Uint8Array[];
  contentType: string;
  offset: number;
  maxChunkBytes: number;
  tailOffset: number;
  closed: boolean;
  segmentStart?: number;
}): ReadResult {
  const {
    messages,
    contentType,
    offset,
    maxChunkBytes,
    tailOffset,
    closed,
    segmentStart = 0,
  } = params;

  const isJson = isJsonContentType(contentType);

  if (isJson) {
    return readJsonMessages(messages, offset, maxChunkBytes, tailOffset, closed, segmentStart);
  }

  return readBinaryMessages(messages, offset, maxChunkBytes, tailOffset, closed, segmentStart);
}

function readJsonMessages(
  messages: Uint8Array[],
  offset: number,
  maxChunkBytes: number,
  tailOffset: number,
  closed: boolean,
  segmentStart: number,
): ReadResult {
  const relativeOffset = offset - segmentStart;

  // Validate offset bounds
  if (relativeOffset < 0 || relativeOffset > messages.length) {
    return errorResult(offset, errorResponse(400, "invalid offset"));
  }

  // Collect chunks up to byte limit
  const chunks: Array<{ body: Uint8Array; sizeBytes: number }> = [];
  let bytes = 0;

  for (let i = relativeOffset; i < messages.length; i++) {
    const message = messages[i];
    if (bytes + message.byteLength > maxChunkBytes && bytes > 0) break;

    chunks.push({ body: message, sizeBytes: message.byteLength });
    bytes += message.byteLength;

    if (bytes >= maxChunkBytes) break;
  }

  // Build result
  if (chunks.length === 0) {
    const upToDate = offset === tailOffset;
    return emptyResult(offset, {
      upToDate,
      closedAtTail: closed && upToDate,
      emptyBody: emptyJsonArray(),
    });
  }

  const nextOffset = offset + chunks.length;
  return dataResult({
    body: buildJsonArray(chunks.map((c) => ({ body: c.body, sizeBytes: c.sizeBytes }))),
    nextOffset,
    tailOffset,
    closed,
  });
}

function readBinaryMessages(
  messages: Uint8Array[],
  offset: number,
  maxChunkBytes: number,
  tailOffset: number,
  closed: boolean,
  segmentStart: number,
): ReadResult {
  const chunks: Array<{ body: Uint8Array; sizeBytes: number }> = [];
  let bytes = 0;
  let cursor = segmentStart;

  for (const message of messages) {
    const end = cursor + message.byteLength;

    // Skip messages before offset
    if (end <= offset) {
      cursor = end;
      continue;
    }

    // Slice message if offset is in the middle
    const sliceStart = offset > cursor ? offset - cursor : 0;
    let slice = message.slice(sliceStart);

    // Check byte limit
    if (bytes + slice.byteLength > maxChunkBytes && bytes > 0) break;

    // Truncate if exceeds limit
    if (bytes + slice.byteLength > maxChunkBytes) {
      slice = slice.slice(0, maxChunkBytes - bytes);
    }

    chunks.push({ body: slice, sizeBytes: slice.byteLength });
    bytes += slice.byteLength;
    cursor = end;

    if (bytes >= maxChunkBytes) break;
  }

  // Build result
  if (chunks.length === 0) {
    const upToDate = offset === tailOffset;
    return emptyResult(offset, { upToDate, closedAtTail: closed && upToDate });
  }

  const nextOffset = offset + bytes;
  return dataResult({
    body: concatBuffers(chunks.map((c) => c.body)),
    nextOffset,
    tailOffset,
    closed,
  });
}
