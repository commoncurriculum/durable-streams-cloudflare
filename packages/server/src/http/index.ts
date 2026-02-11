import { Hono } from "hono";
import { arktypeValidator } from "@hono/arktype-validator";
import { logger } from "hono/logger";
import type { StreamDO } from "./durable-object";
import type { InFlightResult } from "./middleware/coalesce";
import type { StreamMeta } from "./middleware/cache";
import type { Timing } from "./shared/timing";
import type {
  ProjectConfig,
  ProjectJwtClaims,
} from "./middleware/authentication";
import type { SubscriptionDO } from "../subscriptions/do";
import type { EstuaryDO } from "../estuary/do";
import type { FanoutQueueMessage } from "../subscriptions/types";

// Middleware
import { pathParsingMiddleware } from "./middleware/path-parsing";
import { corsMiddleware } from "./middleware/cors";
import { authenticationMiddleware } from "./middleware/authentication";
import { authorizationMiddleware } from "./middleware/authorization";
import { timingMiddleware } from "./middleware/timing";
import { createEdgeCacheMiddleware } from "./middleware/edge-cache";

// Route handlers
import {
  projectIdParamSchema,
  configBodySchema,
  getConfig,
  putConfig,
} from "./v1/config";

import {
  subscribe,
  unsubscribe,
  subscribeBodySchema,
  unsubscribeBodySchema,
  getEstuary,
  touchEstuary,
  deleteEstuary,
} from "./v1/estuary";

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
  SUBSCRIPTION_DO: DurableObjectNamespace<SubscriptionDO>;
  ESTUARY_DO: DurableObjectNamespace<EstuaryDO>;
  R2?: R2Bucket;
  DEBUG_TIMING?: string;
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

export function createStreamWorker<
  E extends BaseEnv = BaseEnv
>(): ExportedHandler<E> {
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
      timing: Timing | null;
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
  app.use("/v1/stream/*", timingMiddleware);
  app.use("/v1/stream/*", createEdgeCacheMiddleware(inFlight));
  // #endregion docs-request-arrives

  // Health check
  // biome-ignore lint: Hono context typing is complex
  app.get("/health", (c: any) => {
    return c.text("ok", 200, { "Cache-Control": "no-store" });
  });

  // Config routes
  app.get(
    "/v1/config/:projectId",
    arktypeValidator("param", projectIdParamSchema),
    getConfig
  );
  app.put(
    "/v1/config/:projectId",
    arktypeValidator("param", projectIdParamSchema),
    arktypeValidator("json", configBodySchema),
    putConfig
  );

  // Estuary subscribe/unsubscribe routes
  app.post(
    "/v1/estuary/subscribe/:projectId/:streamId",
    arktypeValidator("json", subscribeBodySchema),
    subscribe
  );

  app.delete(
    "/v1/estuary/subscribe/:projectId/:streamId",
    arktypeValidator("json", unsubscribeBodySchema),
    unsubscribe
  );

  // Estuary management routes
  app.get("/v1/estuary/:projectId/:estuaryId", getEstuary);
  app.post("/v1/estuary/:projectId/:estuaryId", touchEstuary);
  app.delete("/v1/estuary/:projectId/:estuaryId", deleteEstuary);

  // #region docs-route-to-do
  // Stream route — all pre/post-processing handled by middleware
  // biome-ignore lint: Hono context typing is complex
  app.all("/v1/stream/*", async (c: any) => {
    const timing = c.get("timing");
    const doKey = c.get("streamPath");
    const stub = c.env.STREAMS.getByName(doKey);
    const doneOrigin = timing?.start("edge.origin");
    const response = await stub.routeStreamRequest(doKey, !!timing, c.req.raw);
    doneOrigin?.();
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
    logError(
      { streamPath: c.get("streamPath"), method: c.req.method },
      "unhandled error",
      err
    );
    return errorResponse(500, err.message ?? "internal error");
  });

  return {
    fetch: app.fetch,
    
    // Queue handler for async fanout
    queue: async (
      batch: MessageBatch,
      env: E,
      _ctx: ExecutionContext
    ): Promise<void> => {
      await handleFanoutQueue(batch as MessageBatch<FanoutQueueMessage>, env);
    },
  };
}
