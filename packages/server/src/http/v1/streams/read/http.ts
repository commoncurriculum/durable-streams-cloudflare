import { errorResponse, errorToResponse, ErrorCode } from "../../../shared/errors";
import { readStream } from "./index";
import type { StreamContext } from "../types";
import { handleLongPoll, handleWsUpgrade } from "../realtime/handlers";

/**
 * HTTP handler for GET /streams/{streamId}
 *
 * Parses the HTTP request and calls readStream (THE ONE function).
 */
export async function readStreamHttp(
  ctx: StreamContext,
  streamId: string,
  request: Request,
  url: URL,
): Promise<Response> {
  try {
    // 1. Check for live modes (HTTP-specific realtime features)
    const live = url.searchParams.get("live");

    if (live === "long-poll") {
      // Long-poll needs stream metadata first
      const doneGetStream = ctx.timing?.start("do.getStream");
      const meta = await ctx.getStream(streamId);
      doneGetStream?.();
      if (!meta) return errorResponse(404, ErrorCode.STREAM_NOT_FOUND, "stream not found");
      return handleLongPoll(ctx, streamId, meta, url);
    }

    if (live === "ws-internal") {
      const doneGetStream = ctx.timing?.start("do.getStream");
      const meta = await ctx.getStream(streamId);
      doneGetStream?.();
      if (!meta) return errorResponse(404, ErrorCode.STREAM_NOT_FOUND, "stream not found");
      return handleWsUpgrade(ctx, streamId, meta, url, request);
    }

    // 2. Determine read mode from query params
    const offsetParam = url.searchParams.get("offset") ?? "-1";
    const cursor = url.searchParams.get("cursor");

    let mode: "head" | "now" | "offset";
    if (offsetParam === "now") {
      mode = "now";
    } else {
      mode = "offset";
    }

    // 3. Call THE ONE function
    const result = await readStream(ctx, {
      streamId,
      mode,
      offset: offsetParam,
      cursor,
    });

    // 4. Handle ETag conditional request (HTTP protocol concern)
    if (result.body !== null) {
      const ifNoneMatch = request.headers.get("If-None-Match");
      const etag = result.headers.get("ETag");
      if (ifNoneMatch && etag && ifNoneMatch === etag) {
        return new Response(null, { status: 304, headers: result.headers });
      }
    }

    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  } catch (error) {
    return errorToResponse(error);
  }
}

/**
 * HTTP handler for HEAD /streams/{streamId}
 *
 * Parses the HTTP request and calls readStream (THE ONE function).
 */
export async function headStreamHttp(ctx: StreamContext, streamId: string): Promise<Response> {
  try {
    // Call THE ONE function in head mode
    const result = await readStream(ctx, {
      streamId,
      mode: "head",
    });

    return new Response(null, {
      status: result.status,
      headers: result.headers,
    });
  } catch (error) {
    return errorToResponse(error);
  }
}
