import { isJsonContentType } from "../../http/shared/headers";
import { toUint8Array } from "../../http/v1/streams/shared/encoding";
import {
  buildJsonArray,
  emptyJsonArray,
} from "../../http/v1/streams/shared/json";
import { concatBuffers } from "../../http/v1/streams/shared/encoding";
import { errorResponse } from "../../http/shared/errors";
import type { StreamMeta, StreamStorage } from "../types";
import type { ReadResult } from "./types";

export async function readFromOffset(
  storage: StreamStorage,
  streamId: string,
  meta: StreamMeta,
  offset: number,
  maxChunkBytes: number
): Promise<ReadResult> {
  const chunks: Array<{
    start_offset: number;
    end_offset: number;
    size_bytes: number;
    body: ArrayBuffer | Uint8Array | string | number[];
    created_at: number;
  }> = [];

  let maxCreatedAt = 0;

  if (offset > 0) {
    const overlap = await storage.selectOverlap(streamId, offset);

    if (overlap) {
      if (
        isJsonContentType(meta.content_type) &&
        overlap.start_offset !== offset
      ) {
        return {
          body: new ArrayBuffer(0),
          nextOffset: offset,
          upToDate: false,
          closedAtTail: false,
          hasData: false,
          writeTimestamp: 0,
          error: errorResponse(400, "invalid offset"),
        };
      }
      const sliceStart = offset - overlap.start_offset;
      const source = toUint8Array(overlap.body);
      const slice = source.slice(sliceStart);
      chunks.push({
        start_offset: offset,
        end_offset: overlap.end_offset,
        size_bytes: slice.byteLength,
        body: slice,
        created_at: overlap.created_at,
      });
      if (overlap.created_at > maxCreatedAt) maxCreatedAt = overlap.created_at;
    }
  }

  let bytes = chunks.reduce((sum, chunk) => sum + chunk.size_bytes, 0);
  let cursor = offset;

  while (bytes < maxChunkBytes) {
    const rows = await storage.selectOpsFrom(streamId, cursor);
    if (rows.length === 0) break;

    let reachedLimit = false;
    const prevCursor = cursor;

    for (const row of rows) {
      if (bytes + row.size_bytes > maxChunkBytes && bytes > 0) {
        reachedLimit = true;
        break;
      }
      const body = toUint8Array(row.body);
      chunks.push({
        start_offset: row.start_offset,
        end_offset: row.end_offset,
        size_bytes: row.size_bytes,
        body,
        created_at: row.created_at,
      });
      if (row.created_at > maxCreatedAt) maxCreatedAt = row.created_at;
      bytes += row.size_bytes;
      cursor = row.end_offset;
      if (bytes >= maxChunkBytes) {
        reachedLimit = true;
        break;
      }
    }

    if (reachedLimit) break;

    if (rows.length < 200) break;
    if (cursor === prevCursor) break;
  }

  if (chunks.length === 0) {
    const upToDate = offset === meta.tail_offset;
    const closedAtTail = meta.closed === 1 && upToDate;
    if (isJsonContentType(meta.content_type)) {
      const empty = emptyJsonArray();
      return {
        body: empty,
        nextOffset: offset,
        upToDate,
        closedAtTail,
        hasData: false,
        writeTimestamp: 0,
      };
    }
    return {
      body: new ArrayBuffer(0),
      nextOffset: offset,
      upToDate,
      closedAtTail,
      hasData: false,
      writeTimestamp: 0,
    };
  }

  const nextOffset = chunks[chunks.length - 1].end_offset;
  const upToDate = nextOffset === meta.tail_offset;
  const closedAtTail = meta.closed === 1 && upToDate;

  let body: ArrayBuffer;
  if (isJsonContentType(meta.content_type)) {
    body = buildJsonArray(
      chunks.map((chunk) => ({ body: chunk.body, sizeBytes: chunk.size_bytes }))
    );
  } else {
    body = concatBuffers(chunks.map((chunk) => toUint8Array(chunk.body)));
  }

  return {
    body,
    nextOffset,
    upToDate,
    closedAtTail,
    hasData: true,
    writeTimestamp: maxCreatedAt,
  };
}
