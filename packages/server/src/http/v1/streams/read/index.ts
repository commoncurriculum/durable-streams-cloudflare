import { buildEtag } from "../shared/etag";
import { MAX_CHUNK_BYTES } from "../../../shared/limits";
import { ZERO_OFFSET } from "../shared/offsets";
import {
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_CURSOR,
  HEADER_STREAM_NEXT_OFFSET,
  HEADER_STREAM_UP_TO_DATE,
  HEADER_STREAM_WRITE_TIMESTAMP,
  baseHeaders,
  isJsonContentType,
} from "../../../shared/headers";
import { cacheControlFor, applyExpiryHeaders } from "../../../shared/expiry";
import { emptyJsonArray } from "../shared/json";
import { HttpError } from "../../../shared/errors";
import type { StreamContext } from "../types";

export type ReadStreamOptions = {
  streamId: string;
  mode: "head" | "now" | "offset";
  offset?: string | null;
  cursor?: string | null;
};

export type ReadStreamResult = {
  status: 200 | 304;
  headers: Headers;
  body: ArrayBuffer | null;
};

/**
 * THE ONE complete read function that does everything.
 *
 * Both HTTP and RPC call this single function.
 */
export async function readStream(
  ctx: StreamContext,
  opts: ReadStreamOptions
): Promise<ReadStreamResult> {
  const streamId = opts.streamId;
  const mode = opts.mode;
  const offsetParam = opts.offset ?? null;
  const cursor = opts.cursor ?? null;

  // 1. Get and validate stream exists
  const doneGetStream = ctx.timing?.start("do.getStream");
  const meta = await ctx.getStream(streamId);
  doneGetStream?.();

  if (!meta) {
    throw new HttpError(404, "stream not found");
  }

  // 2. HEAD mode - return metadata only
  if (mode === "head") {
    const nextOffsetHeader = await ctx.encodeTailOffset(streamId, meta);
    const headers = baseHeaders({
      "Content-Type": meta.content_type,
      [HEADER_STREAM_NEXT_OFFSET]: nextOffsetHeader,
      "Cache-Control": "no-store",
    });

    if (meta.closed === 1) headers.set(HEADER_STREAM_CLOSED, "true");
    applyExpiryHeaders(headers, meta);

    return {
      status: 200,
      headers,
      body: null,
    };
  }

  // 3. "now" mode - return empty response at tail
  if (mode === "now") {
    const nextOffsetHeader = await ctx.encodeOffset(
      streamId,
      meta,
      meta.tail_offset
    );
    const headers = baseHeaders({
      "Content-Type": meta.content_type,
      [HEADER_STREAM_NEXT_OFFSET]: nextOffsetHeader,
      [HEADER_STREAM_UP_TO_DATE]: "true",
    });
    if (meta.closed === 1) headers.set(HEADER_STREAM_CLOSED, "true");
    applyExpiryHeaders(headers, meta);
    headers.set("Cache-Control", "no-store");

    const body = isJsonContentType(meta.content_type)
      ? emptyJsonArray()
      : new ArrayBuffer(0);

    return {
      status: 200,
      headers,
      body,
    };
  }

  // 4. Normal offset read
  const resolved = await ctx.resolveOffset(
    streamId,
    meta,
    offsetParam === "-1" || !offsetParam ? ZERO_OFFSET : offsetParam
  );
  if (resolved.error) {
    throw new HttpError(
      resolved.error.status,
      "invalid offset",
      resolved.error
    );
  }

  const { offset } = resolved;
  const read = await ctx.readFromOffset(
    streamId,
    meta,
    offset,
    MAX_CHUNK_BYTES
  );
  if (read.error) {
    throw new HttpError(read.error.status, "read error", read.error);
  }

  // 5. Build response headers
  const nextOffsetHeader = await ctx.encodeOffset(
    streamId,
    meta,
    read.nextOffset
  );
  const headers = baseHeaders({
    "Content-Type": meta.content_type,
    [HEADER_STREAM_NEXT_OFFSET]: nextOffsetHeader,
  });

  if (read.upToDate) headers.set(HEADER_STREAM_UP_TO_DATE, "true");
  if (read.closedAtTail) headers.set(HEADER_STREAM_CLOSED, "true");
  if (cursor) headers.set(HEADER_STREAM_CURSOR, cursor);
  if (read.writeTimestamp && read.writeTimestamp > 0) {
    headers.set(HEADER_STREAM_WRITE_TIMESTAMP, String(read.writeTimestamp));
  }

  applyExpiryHeaders(headers, meta);

  const etag = buildEtag(streamId, offset, read.nextOffset, meta.closed === 1);
  headers.set("ETag", etag);
  headers.set("Cache-Control", cacheControlFor(meta));

  // 6. Record metrics
  if (ctx.env.METRICS) {
    ctx.env.METRICS.writeDataPoint({
      indexes: [streamId],
      blobs: [streamId, "read", "anonymous"],
      doubles: [1, read.body.byteLength],
    });
  }

  return {
    status: 200,
    headers,
    body: read.body,
  };
}
