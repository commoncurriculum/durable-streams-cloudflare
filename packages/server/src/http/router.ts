import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
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
import { rejectEmptyQueryParams } from "./middleware/query-validation";

// Limits
import { MAX_APPEND_BYTES } from "./shared/limits";

// Route handlers
import {
  projectIdParamSchema,
  putConfigRequestSchema,
  getConfigResponseSchema,
  putConfigResponseSchema,
  getConfig,
  putConfig,
} from "./v1/config";

// Estuary endpoints
import { subscribeHttp, subscribeRequestSchema } from "./v1/estuary/subscribe/http";
import { unsubscribeHttp, unsubscribeRequestSchema } from "./v1/estuary/unsubscribe/http";
import { getEstuaryHttp } from "./v1/estuary/get/http";
import { touchEstuaryHttp } from "./v1/estuary/touch/http";
import { deleteEstuaryHttp } from "./v1/estuary/delete/http";
import {
  subscribeResponseSchema,
  unsubscribeResponseSchema,
  getEstuaryResponseSchema,
  touchEstuaryResponseSchema,
  deleteEstuaryResponseSchema,
} from "./v1/estuary/types";

// Queue handler
import { handleFanoutQueue } from "../queue/fanout-consumer";

// Error handling
import { errorResponse, errorResponseSchema, ErrorCode } from "./shared/errors";
import { logError } from "../log";

// ArkType schemas using `.pipe()` (morphs) can't be auto-converted to JSON Schema.
// This fallback tells ArkType to emit the input (base) schema instead of throwing.
// The `options` key is required because standard-openapi destructures context as
// `{ components, options }` and passes `options` to `schema.toJsonSchema(options)`.
const morphFallback = {
  options: { fallback: { morph: (ctx: { base: unknown }) => ctx.base } },
} as Record<string, unknown>;

// Shared error response content for OpenAPI — reused across all error status codes.
const errorContent = {
  content: { "application/json": { schema: resolver(errorResponseSchema) } },
};

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

// biome-ignore lint: Hono<AppEnv> is not assignable to Hono<BlankEnv>; AppEnv is local to factory
export function createStreamWorker<E extends BaseEnv = BaseEnv>(): ExportedHandler<E> & {
  app: Hono<any>;
} {
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
  app.use("/v1/stream/:streamPath{.+}", authorizationMiddleware);
  app.use("/v1/stream/:streamPath{.+}", timingMiddleware());
  app.use("/v1/stream/:streamPath{.+}", bodySizeLimit(MAX_APPEND_BYTES));
  app.use("/v1/stream/:streamPath{.+}", rejectEmptyQueryParams(["offset", "cursor"]));
  app.use("/v1/stream/:streamPath{.+}", createEdgeCacheMiddleware(inFlight));
  // #endregion docs-request-arrives

  // Health check
  app.get(
    "/health",
    describeRoute({
      tags: ["Health"],
      summary: "Health check",
      description: "Returns 200 OK if the worker is running.",
      responses: {
        200: {
          description: "Worker is healthy",
          content: { "text/plain": { schema: { type: "string", example: "ok" } } },
        },
      },
    }),
    // biome-ignore lint: Hono context typing is complex
    (c: any) => {
      return c.text("ok", 200, { "Cache-Control": "no-store" });
    },
  );

  // OPTIONS for health (preflight) - no CORS headers for non-stream routes
  app.options(
    "/health",
    describeRoute({ hide: true }),
    // biome-ignore lint: Hono context typing is complex
    (c: any) => {
      return c.body(null, 204);
    },
  );

  // Config routes
  app.get(
    "/v1/config/:projectId",
    describeRoute({
      tags: ["Config"],
      summary: "Get project configuration",
      description:
        "Retrieve signing secrets, CORS origins, and public flag for a project. Requires a manage-scope JWT.",
      responses: {
        200: {
          description: "Project configuration",
          content: {
            "application/json": {
              schema: resolver(getConfigResponseSchema, morphFallback),
            },
          },
        },
        401: { description: "Unauthorized — missing or invalid JWT", ...errorContent },
        403: {
          description: "Forbidden — JWT scope is not 'manage' or sub doesn't match project",
          ...errorContent,
        },
        404: { description: "Project not found", ...errorContent },
      },
    }),
    validator("param", projectIdParamSchema, undefined, morphFallback),
    getConfig,
  );
  app.put(
    "/v1/config/:projectId",
    describeRoute({
      tags: ["Config"],
      summary: "Update project configuration",
      description:
        "Set signing secrets, CORS origins, and public flag for a project. Requires a manage-scope JWT.",
      responses: {
        200: {
          description: "Configuration updated",
          content: {
            "application/json": {
              schema: resolver(putConfigResponseSchema, morphFallback),
            },
          },
        },
        401: { description: "Unauthorized", ...errorContent },
        403: { description: "Forbidden", ...errorContent },
      },
    }),
    validator("param", projectIdParamSchema, undefined, morphFallback),
    validator("json", putConfigRequestSchema),
    putConfig,
  );

  // Estuary subscribe/unsubscribe routes
  app.post(
    "/v1/estuary/subscribe/:estuaryPath{.+}",
    describeRoute({
      tags: ["Estuary"],
      summary: "Subscribe estuary to a stream",
      description:
        "Subscribe an estuary to a source stream. Messages published to the source are fan-out replicated to the estuary stream.",
      responses: {
        200: {
          description: "Subscription created",
          content: {
            "application/json": { schema: resolver(subscribeResponseSchema) },
          },
        },
      },
    }),
    validator("json", subscribeRequestSchema, undefined, morphFallback),
    subscribeHttp,
  );

  app.delete(
    "/v1/estuary/subscribe/:estuaryPath{.+}",
    describeRoute({
      tags: ["Estuary"],
      summary: "Unsubscribe estuary from a stream",
      description: "Remove an estuary's subscription to a source stream.",
      responses: {
        200: {
          description: "Unsubscribed",
          content: {
            "application/json": { schema: resolver(unsubscribeResponseSchema) },
          },
        },
      },
    }),
    validator("json", unsubscribeRequestSchema, undefined, morphFallback),
    unsubscribeHttp,
  );

  // Estuary management routes
  app.get(
    "/v1/estuary/:estuaryPath{.+}",
    describeRoute({
      tags: ["Estuary"],
      summary: "Get estuary info",
      description: "Retrieve estuary metadata including subscriptions and content type.",
      responses: {
        200: {
          description: "Estuary info",
          content: {
            "application/json": { schema: resolver(getEstuaryResponseSchema) },
          },
        },
      },
    }),
    getEstuaryHttp,
  );
  app.post(
    "/v1/estuary/:estuaryPath{.+}",
    describeRoute({
      tags: ["Estuary"],
      summary: "Touch estuary",
      description: "Create or extend the TTL of an estuary stream.",
      responses: {
        200: {
          description: "Estuary touched",
          content: {
            "application/json": { schema: resolver(touchEstuaryResponseSchema) },
          },
        },
      },
    }),
    touchEstuaryHttp,
  );
  app.delete(
    "/v1/estuary/:estuaryPath{.+}",
    describeRoute({
      tags: ["Estuary"],
      summary: "Delete estuary",
      description: "Delete an estuary and its underlying stream.",
      responses: {
        200: {
          description: "Estuary deleted",
          content: {
            "application/json": { schema: resolver(deleteEstuaryResponseSchema) },
          },
        },
      },
    }),
    deleteEstuaryHttp,
  );

  // #region docs-route-to-do
  // Stream route — all pre/post-processing handled by middleware.
  // Each method is registered separately so hono-openapi emits per-method OpenAPI paths
  // (app.all() stores specs as shared context rather than standalone paths).
  // biome-ignore lint: Hono context typing is complex
  const streamHandler = async (c: any) => {
    const doKey = c.get("streamPath");
    const stub = c.env.STREAMS.getByName(doKey);
    const doneOrigin = createTimer(c, "edge.origin");
    const response = await stub.routeStreamRequest(doKey, c.req.raw);
    doneOrigin();
    return response;
  };

  const streamPath = "/v1/stream/:streamPath{.+}";

  app.put(
    streamPath,
    describeRoute({
      tags: ["Streams"],
      summary: "Create a stream",
      description:
        "Create a new append-only stream. The Content-Type header sets the stream's content type.",
      responses: {
        201: { description: "Stream created" },
        409: { description: "Stream already exists", ...errorContent },
      },
    }),
    streamHandler,
  );
  app.post(
    streamPath,
    describeRoute({
      tags: ["Streams"],
      summary: "Append to a stream",
      description:
        "Append one or more messages to an existing stream. Content-Type must match the stream's content type.",
      responses: {
        200: { description: "Messages appended" },
        204: { description: "Close-only append (no payload)" },
        404: { description: "Stream not found", ...errorContent },
        409: { description: "Content-type mismatch", ...errorContent },
        413: { description: "Payload too large", ...errorContent },
      },
    }),
    streamHandler,
  );
  app.get(
    streamPath,
    describeRoute({
      tags: ["Streams"],
      summary: "Read from a stream",
      description:
        "Read messages from a stream. Supports offset/cursor query params, long-poll (Prefer: wait=N), SSE (Accept: text/event-stream), and WebSocket (Upgrade: websocket).",
      responses: {
        200: { description: "Messages returned" },
        304: { description: "Not modified (conditional GET with ETag)" },
        404: { description: "Stream not found", ...errorContent },
      },
    }),
    streamHandler,
  );
  app.delete(
    streamPath,
    describeRoute({
      tags: ["Streams"],
      summary: "Delete a stream",
      description: "Permanently delete a stream and all its data.",
      responses: {
        204: { description: "Stream deleted" },
        404: { description: "Stream not found", ...errorContent },
      },
    }),
    streamHandler,
  );
  // #endregion docs-route-to-do

  // 404 fallback
  // biome-ignore lint: Hono context typing is complex
  app.all("*", (c: any) => {
    return c.text("not found", 404, { "Cache-Control": "no-store" });
  });

  // biome-ignore lint: Hono context typing is complex
  app.onError((err: Error, c: any) => {
    logError({ streamPath: c.get("streamPath"), method: c.req.method }, "unhandled error", err);
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, err.message ?? "internal error");
  });

  return {
    app,
    fetch: app.fetch,

    // Queue handler for async fanout
    queue: async (batch: MessageBatch, env: E, _ctx: ExecutionContext): Promise<void> => {
      await handleFanoutQueue(batch as MessageBatch<FanoutQueueMessage>, env);
    },
  };
}
