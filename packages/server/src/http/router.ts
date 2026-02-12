import { Hono } from "hono";
import { arktypeValidator } from "@hono/arktype-validator";
import { logger } from "hono/logger";
import type { StreamDO } from "./v1/streams";
import type { InFlightResult } from "./middleware/coalesce";
import type { StreamMeta } from "./middleware/cache";

import type { ProjectConfig, ProjectJwtClaims } from "./middleware/authentication";
import type { StreamSubscribersDO, EstuaryDO, FanoutQueueMessage } from "./v1/estuary";

// Middleware
import { pathParsingMiddleware } from "./middleware/path-parsing";
import { corsMiddleware } from "./middleware/cors";
import { authenticationMiddleware } from "./middleware/authentication";
import { authorizationMiddleware } from "./middleware/authorization";
import { timingMiddleware, createTimer } from "./middleware/timing";
import { createEdgeCacheMiddleware } from "./middleware/edge-cache";
import { bodySizeLimit } from "./middleware/body-size";

// Limits
import { MAX_APPEND_BYTES } from "./shared/limits";

// Route handlers
import { projectIdParamSchema, configBodySchema, getConfig, putConfig } from "./v1/config";

// Estuary endpoints
import { subscribeHttp, subscribeBodySchema } from "./v1/estuary/subscribe/http";
import { unsubscribeHttp, unsubscribeBodySchema } from "./v1/estuary/unsubscribe/http";
import { getEstuaryHttp } from "./v1/estuary/get/http";
import { touchEstuaryHttp } from "./v1/estuary/touch/http";
import { deleteEstuaryHttp } from "./v1/estuary/delete/http";

// Queue handler
import { handleFanoutQueue } from "../queue/fanout-consumer";

// Error handling
import { errorResponse } from "./shared/errors";
import { logError } from "../log";

// ============================================================================
// Types
// ============================================================================

export type BaseEnv = {
  STREAMS: DurableObjectNamespace<StreamDO>;
  SUBSCRIPTION_DO: DurableObjectNamespace<StreamSubscribersDO>;
  ESTUARY_DO: DurableObjectNamespace<EstuaryDO>;
  R2?: R2Bucket;
  METRICS?: AnalyticsEngineDataset;
  /**
   * KV namespace storing per-project signing secrets and stream metadata.
   * SECURITY: Must use private ACL — contains JWT signing secrets.
   */
  REGISTRY: KVNamespace;
  /**
   * Comma-separated list of CORS origins that are allowed for ALL projects,
   * in addition to each project's own corsOrigins list.
   * Example: "https://admin.example.com,https://dashboard.example.com"
   */
  CORS_ORIGINS?: string;
  ESTUARY_TTL_SECONDS?: string;
  FANOUT_QUEUE?: Queue<FanoutQueueMessage>;
  FANOUT_QUEUE_THRESHOLD?: string;
  MAX_INLINE_FANOUT?: string;
};

export { PROJECT_ID_PATTERN } from "./shared/stream-path";

// ============================================================================
// Factory
// ============================================================================

export function createStreamWorker<E extends BaseEnv = BaseEnv>(): ExportedHandler<E> {
  type AppEnv = {
    Bindings: E;
    Variables: {
      projectConfig: ProjectConfig | null;
      jwtClaims: ProjectJwtClaims | null;
      projectId: string | null;
      streamId: string | null;
      streamPath: string | null;
      corsOrigin: string | null;
      streamMeta: StreamMeta | null;
    };
  };

  const inFlight = new Map<string, Promise<InFlightResult>>();
  const app = new Hono<AppEnv>();

  // Hono's logger middleware for HTTP request logging
  app.use("*", logger());

  // #region docs-request-arrives
  // Global middleware
  app.use("*", pathParsingMiddleware);
  app.use("*", corsMiddleware);
  app.use("*", authenticationMiddleware);

  // Stream-scoped middleware
  app.use("/v1/stream/*", authorizationMiddleware);
  app.use("/v1/stream/*", timingMiddleware());
  app.use("/v1/stream/*", bodySizeLimit(MAX_APPEND_BYTES));
  app.use("/v1/stream/*", createEdgeCacheMiddleware(inFlight));
  // #endregion docs-request-arrives

  // Health check
  // biome-ignore lint: Hono context typing is complex
  app.get("/health", (c: any) => {
    return c.text("ok", 200, { "Cache-Control": "no-store" });
  });

  // OPTIONS for health (preflight) - no CORS headers for non-stream routes
  // biome-ignore lint: Hono context typing is complex
  app.options("/health", (c: any) => {
    return c.body(null, 204);
  });

  // Config routes
  app.get("/v1/config/:projectId", arktypeValidator("param", projectIdParamSchema), getConfig);
  app.put(
    "/v1/config/:projectId",
    arktypeValidator("param", projectIdParamSchema),
    arktypeValidator("json", configBodySchema),
    putConfig,
  );

  // Estuary subscribe/unsubscribe routes
  app.post("/v1/estuary/subscribe/*", arktypeValidator("json", subscribeBodySchema), subscribeHttp);

  app.delete(
    "/v1/estuary/subscribe/*",
    arktypeValidator("json", unsubscribeBodySchema),
    unsubscribeHttp,
  );

  // Estuary management routes
  app.get("/v1/estuary/*", getEstuaryHttp);
  app.post("/v1/estuary/*", touchEstuaryHttp);
  app.delete("/v1/estuary/*", deleteEstuaryHttp);

  // #region docs-route-to-do
  // Stream route — all pre/post-processing handled by middleware
  // biome-ignore lint: Hono context typing is complex
  app.all("/v1/stream/*", async (c: any) => {
    const doKey = c.get("streamPath");
    const stub = c.env.STREAMS.getByName(doKey);
    const doneOrigin = createTimer(c, "edge.origin");
    const response = await stub.routeStreamRequest(doKey, c.req.raw);
    doneOrigin();
    return response;
  });
  // #endregion docs-route-to-do

  // 404 fallback
  // biome-ignore lint: Hono context typing is complex
  app.all("*", (c: any) => {
    return c.text("not found", 404, { "Cache-Control": "no-store" });
  });

  // biome-ignore lint: Hono context typing is complex
  app.onError((err: Error, c: any) => {
    logError({ streamPath: c.get("streamPath"), method: c.req.method }, "unhandled error", err);
    return errorResponse(500, err.message ?? "internal error");
  });

  return {
    fetch: app.fetch,

    // Queue handler for async fanout
    queue: async (batch: MessageBatch, env: E, _ctx: ExecutionContext): Promise<void> => {
      await handleFanoutQueue(batch as MessageBatch<FanoutQueueMessage>, env);
    },
  };
}
