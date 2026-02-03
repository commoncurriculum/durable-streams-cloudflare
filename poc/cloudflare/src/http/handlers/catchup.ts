import { errorResponse } from "../../protocol/errors";
import { buildReadResponse, buildHeadResponse } from "../../engine/stream";
import { MAX_CHUNK_BYTES } from "../../protocol/limits";
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

  const offsetParam = url.searchParams.get("offset");
  if (!offsetParam) return errorResponse(400, "offset is required");
  const resolved = await ctx.resolveOffset(streamId, meta, offsetParam);
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

  return buildHeadResponse(meta, ctx.encodeTailOffset(meta));
}
