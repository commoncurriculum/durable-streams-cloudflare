import { errorResponse } from "../../protocol/errors";
import { buildReadResponse, buildHeadResponse } from "../../engine/stream";
import { MAX_CHUNK_BYTES } from "../../protocol/limits";
import { ZERO_OFFSET } from "../../protocol/offsets";
import {
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_NEXT_OFFSET,
  HEADER_STREAM_UP_TO_DATE,
  baseHeaders,
  isJsonContentType,
} from "../../protocol/headers";
import { applyExpiryHeaders } from "../../protocol/expiry";
import { emptyJsonArray } from "../../protocol/json";
import type { StreamContext } from "../context";
import { handleLongPoll, handleSse } from "./realtime";

export async function handleGet(
  ctx: StreamContext,
  streamId: string,
  request: Request,
  url: URL,
): Promise<Response> {
  const meta = await ctx.getStream(streamId);
  if (!meta) return errorResponse(404, "stream not found");

  const live = url.searchParams.get("live");
  if (live === "long-poll") {
    return handleLongPoll(ctx, streamId, meta, url);
  }

  if (live === "sse") {
    return handleSse(ctx, streamId, meta, url);
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
  if (read.source === "hot") {
    response.headers.set("Cache-Control", "private, no-store");
  }

  const ifNoneMatch = request.headers.get("If-None-Match");
  const etag = response.headers.get("ETag");
  if (ifNoneMatch && etag && ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: response.headers });
  }

  return response;
}

export async function handleHead(ctx: StreamContext, streamId: string): Promise<Response> {
  const meta = await ctx.getStream(streamId);
  if (!meta) return errorResponse(404, "stream not found");

  return buildHeadResponse(meta, await ctx.encodeTailOffset(streamId, meta));
}
