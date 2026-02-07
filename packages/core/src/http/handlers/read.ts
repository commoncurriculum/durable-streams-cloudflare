import { errorResponse } from "../../protocol/errors";
import { buildEtag } from "../../protocol/etag";
import { MAX_CHUNK_BYTES } from "../../protocol/limits";
import { ZERO_OFFSET } from "../../protocol/offsets";
import {
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_CURSOR,
  HEADER_STREAM_NEXT_OFFSET,
  HEADER_STREAM_UP_TO_DATE,
  baseHeaders,
  isJsonContentType,
} from "../../protocol/headers";
import { cacheControlFor, applyExpiryHeaders } from "../../protocol/expiry";
import { emptyJsonArray } from "../../protocol/json";
import type { StreamMeta } from "../../storage/types";
import type { StreamContext } from "../router";
import { handleLongPoll, handleSse } from "./realtime";

// ============================================================================
// Response Builders (from engine/stream.ts)
// ============================================================================

export function buildHeadResponse(meta: StreamMeta, nextOffsetHeader: string): Response {
  const headers = baseHeaders({
    "Content-Type": meta.content_type,
    [HEADER_STREAM_NEXT_OFFSET]: nextOffsetHeader,
    "Cache-Control": "no-store",
  });

  if (meta.closed === 1) headers.set(HEADER_STREAM_CLOSED, "true");
  applyExpiryHeaders(headers, meta);

  return new Response(null, { status: 200, headers });
}

export function buildReadResponse(params: {
  streamId: string;
  meta: StreamMeta;
  body: ArrayBuffer;
  nextOffset: number;
  nextOffsetHeader: string;
  upToDate: boolean;
  closedAtTail: boolean;
  includeCursor?: string | null;
  offset: number;
}): Response {
  const headers = baseHeaders({
    "Content-Type": params.meta.content_type,
    [HEADER_STREAM_NEXT_OFFSET]: params.nextOffsetHeader,
  });

  if (params.upToDate) headers.set(HEADER_STREAM_UP_TO_DATE, "true");
  if (params.closedAtTail) headers.set(HEADER_STREAM_CLOSED, "true");
  if (params.includeCursor) headers.set(HEADER_STREAM_CURSOR, params.includeCursor);

  applyExpiryHeaders(headers, params.meta);

  const etag = buildEtag(
    params.streamId,
    params.offset,
    params.nextOffset,
    params.meta.closed === 1,
  );
  headers.set("ETag", etag);
  headers.set("Cache-Control", cacheControlFor(params.meta));

  return new Response(params.body, { status: 200, headers });
}

// ============================================================================
// Handlers
// ============================================================================

// #region docs-handle-get
export async function handleGet(
  ctx: StreamContext,
  streamId: string,
  request: Request,
  url: URL,
): Promise<Response> {
  const meta = await ctx.getStream(streamId);
  if (!meta) return errorResponse(404, "stream not found");

  // Note: Read authorization is handled at the edge worker level via JWT tokens

  // #region docs-sse-mode-detection
  const live = url.searchParams.get("live");
  if (live === "long-poll") {
    return handleLongPoll(ctx, streamId, meta, url);
  }

  if (live === "sse") {
    return handleSse(ctx, streamId, meta, url);
  }
  // #endregion docs-sse-mode-detection
  // #endregion docs-handle-get

  // #region docs-resolve-offset
  const offsetParam = url.searchParams.get("offset") ?? "-1";

  if (offsetParam === "now") {
    const nextOffsetHeader = await ctx.encodeOffset(streamId, meta, meta.tail_offset);
    const headers = baseHeaders({
      "Content-Type": meta.content_type,
      [HEADER_STREAM_NEXT_OFFSET]: nextOffsetHeader,
      [HEADER_STREAM_UP_TO_DATE]: "true",
    });
    if (meta.closed === 1) headers.set(HEADER_STREAM_CLOSED, "true");
    applyExpiryHeaders(headers, meta);
    headers.set("Cache-Control", "no-store");

    const body = isJsonContentType(meta.content_type) ? emptyJsonArray() : new ArrayBuffer(0);
    return new Response(body, { status: 200, headers });
  }

  const resolved = await ctx.resolveOffset(
    streamId,
    meta,
    offsetParam === "-1" ? ZERO_OFFSET : offsetParam,
  );
  if (resolved.error) return resolved.error;

  const { offset } = resolved;
  const read = await ctx.readFromOffset(streamId, meta, offset, MAX_CHUNK_BYTES);
  if (read.error) return read.error;
  // #endregion docs-resolve-offset

  // #region docs-build-response
  const response = buildReadResponse({
    streamId,
    meta,
    body: read.body,
    nextOffset: read.nextOffset,
    nextOffsetHeader: await ctx.encodeOffset(streamId, meta, read.nextOffset),
    upToDate: read.upToDate,
    closedAtTail: read.closedAtTail,
    offset,
  });

  // Record metrics for read
  if (ctx.env.METRICS) {
    ctx.env.METRICS.writeDataPoint({
      indexes: [streamId],
      blobs: [streamId, "read", "anonymous"],
      doubles: [1, read.body.byteLength],
    });
  }

  const ifNoneMatch = request.headers.get("If-None-Match");
  const etag = response.headers.get("ETag");
  if (ifNoneMatch && etag && ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: response.headers });
  }

  return response;
}
// #endregion docs-build-response

export async function handleHead(
  ctx: StreamContext,
  streamId: string,
): Promise<Response> {
  const meta = await ctx.getStream(streamId);
  if (!meta) return errorResponse(404, "stream not found");

  // Note: Read authorization is handled at the edge worker level via JWT tokens
  return buildHeadResponse(meta, await ctx.encodeTailOffset(streamId, meta));
}
