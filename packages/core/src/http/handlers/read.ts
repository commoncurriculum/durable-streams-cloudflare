import { errorResponse } from "../../protocol/errors";
import { buildEtag } from "../../protocol/etag";
import { LONG_POLL_CACHE_SECONDS, MAX_CHUNK_BYTES } from "../../protocol/limits";
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
import { getCacheMode } from "../router";
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

export async function handleGet(
  ctx: StreamContext,
  streamId: string,
  request: Request,
  url: URL,
): Promise<Response> {
  const meta = await ctx.getStream(streamId);
  if (!meta) return errorResponse(404, "stream not found");

  // Note: Read authorization is handled at the edge worker level via JWT tokens
  const cacheMode = getCacheMode(request);

  const live = url.searchParams.get("live");
  if (live === "long-poll") {
    return handleLongPoll(ctx, streamId, meta, request, url);
  }

  if (live === "sse") {
    return handleSse(ctx, streamId, meta, request, url);
  }

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
    headers.set("Cache-Control", cacheMode === "private" ? "private, no-store" : "no-store");

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

  if (cacheMode === "private") {
    response.headers.set("Cache-Control", "private, no-store");
  } else if (read.source === "hot") {
    response.headers.set("Cache-Control", `public, max-age=${LONG_POLL_CACHE_SECONDS}`);
  }

  const ifNoneMatch = request.headers.get("If-None-Match");
  const etag = response.headers.get("ETag");
  if (ifNoneMatch && etag && ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: response.headers });
  }

  return response;
}

export async function handleHead(
  ctx: StreamContext,
  streamId: string,
  request: Request,
): Promise<Response> {
  const meta = await ctx.getStream(streamId);
  if (!meta) return errorResponse(404, "stream not found");

  // Note: Read authorization is handled at the edge worker level via JWT tokens
  const response = buildHeadResponse(meta, await ctx.encodeTailOffset(streamId, meta));
  if (getCacheMode(request) === "private") {
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}
