import { errorResponse } from "../protocol/errors";
import type { StreamContext } from "./context";
import { handleDelete, handlePost, handlePut } from "./handlers/mutation";
import { handleGet, handleHead } from "./handlers/catchup";

export async function routeRequest(
  ctx: StreamContext,
  streamId: string,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  try {
    if (method === "PUT") return await handlePut(ctx, streamId, request);
    if (method === "POST") return await handlePost(ctx, streamId, request);
    if (method === "GET") return await handleGet(ctx, streamId, request, url);
    if (method === "HEAD") return await handleHead(ctx, streamId);
    if (method === "DELETE") return await handleDelete(ctx, streamId);
    return errorResponse(405, "method not allowed");
  } catch (e) {
    return errorResponse(500, e instanceof Error ? e.message : "internal error");
  }
}
