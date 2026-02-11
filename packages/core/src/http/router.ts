import { arktypeValidator } from "@hono/arktype-validator";
import { errorResponse } from "./shared/errors";
import { logError } from "../log";
import { projectIdParamSchema, configBodySchema, getConfig, putConfig } from "./v1/config";
import { createStreamHandler } from "./v1/streams/edge-handler";
import type { StreamContext } from "./v1/streams/types";
import { handlePut } from "./v1/streams/create";
import { handlePost } from "./v1/streams/append";
import { handleDelete } from "./v1/streams/delete";
import { handleGet, handleHead } from "./v1/streams/read";
import type { BaseEnv } from "./index";
import type { InFlightResult } from "./middleware/coalesce";

// ============================================================================
// HTTP Routes
// ============================================================================

// biome-ignore lint: Hono app generic typing is complex
export function mountRoutes<E extends BaseEnv>(app: any, inFlight: Map<string, Promise<InFlightResult>>): void {
  // Health check
  app.get("/health", (c: any) => {
    return c.text("ok", 200, { "Cache-Control": "no-store" });
  });

  // Config routes
  app.get(
    "/v1/config/:projectId",
    arktypeValidator("param", projectIdParamSchema),
    getConfig,
  );
  app.put(
    "/v1/config/:projectId",
    arktypeValidator("param", projectIdParamSchema),
    arktypeValidator("json", configBodySchema),
    putConfig,
  );

  // Stream routes — single wildcard, middleware already parsed projectId/streamId
  const streamHandler = createStreamHandler<E>(inFlight);
  app.all("/v1/stream/*", streamHandler);

  // 404 fallback
  app.all("*", (c: any) => {
    return c.text("not found", 404, { "Cache-Control": "no-store" });
  });
}

// ============================================================================
// DO-Level Method Dispatch
// ============================================================================

// #region docs-route-request
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
    logError({ streamId, method }, "unhandled error in route handler", e);
    return errorResponse(500, e instanceof Error ? e.message : "internal error");
  }
}
// #endregion docs-route-request
