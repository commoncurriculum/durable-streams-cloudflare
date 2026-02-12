import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
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

// ArkType schemas using `.pipe()` (morphs) can't be auto-converted to JSON Schema.
// This fallback tells ArkType to emit the input (base) schema instead of throwing.
// The `options` key is required because standard-openapi destructures context as
// `{ components, options }` and passes `options` to `schema.toJsonSchema(options)`.
const morphFallback = {
  options: { fallback: { morph: (ctx: { base: unknown }) => ctx.base } },
} as Record<string, unknown>;

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
  app.use("/v1/stream/*", authorizationMiddleware);
  app.use("/v1/stream/*", timingMiddleware());
  app.use("/v1/stream/*", bodySizeLimit(MAX_APPEND_BYTES));
  app.use("/v1/stream/*", rejectEmptyQueryParams(["offset", "cursor"]));
  app.use("/v1/stream/*", createEdgeCacheMiddleware(inFlight));
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
              schema: {
                type: "object",
                properties: {
                  signingSecrets: { type: "array", items: { type: "string" } },
                  corsOrigins: { type: "array", items: { type: "string" } },
                  isPublic: { type: "boolean" },
                },
              },
            },
          },
        },
        401: { description: "Unauthorized — missing or invalid JWT" },
        403: { description: "Forbidden — JWT scope is not 'manage' or sub doesn't match project" },
        404: { description: "Project not found" },
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
              schema: { type: "object", properties: { ok: { type: "boolean" } } },
            },
          },
        },
        401: { description: "Unauthorized" },
        403: { description: "Forbidden" },
      },
    }),
    validator("param", projectIdParamSchema, undefined, morphFallback),
    validator("json", configBodySchema),
    putConfig,
  );

  // Estuary subscribe/unsubscribe routes
  app.post(
    "/v1/estuary/subscribe/*",
    describeRoute({
      tags: ["Estuary"],
      summary: "Subscribe estuary to a stream",
      description:
        "Subscribe an estuary to a source stream. Messages published to the source are fan-out replicated to the estuary stream.",
      responses: {
        200: {
          description: "Subscription created",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  estuaryId: { type: "string" },
                  streamId: { type: "string" },
                  estuaryStreamPath: { type: "string" },
                  expiresAt: { type: "number" },
                  isNewEstuary: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    }),
    validator("json", subscribeBodySchema, undefined, morphFallback),
    subscribeHttp,
  );

  app.delete(
    "/v1/estuary/subscribe/*",
    describeRoute({
      tags: ["Estuary"],
      summary: "Unsubscribe estuary from a stream",
      description: "Remove an estuary's subscription to a source stream.",
      responses: {
        200: {
          description: "Unsubscribed",
          content: {
            "application/json": {
              schema: { type: "object", properties: { success: { type: "boolean" } } },
            },
          },
        },
      },
    }),
    validator("json", unsubscribeBodySchema, undefined, morphFallback),
    unsubscribeHttp,
  );

  // Estuary management routes
  app.get(
    "/v1/estuary/*",
    describeRoute({
      tags: ["Estuary"],
      summary: "Get estuary info",
      description: "Retrieve estuary metadata including subscriptions and content type.",
      responses: {
        200: {
          description: "Estuary info",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  estuaryId: { type: "string" },
                  estuaryStreamPath: { type: "string" },
                  subscriptions: {
                    type: "array",
                    items: { type: "object", properties: { streamId: { type: "string" } } },
                  },
                  contentType: { type: ["string", "null"] },
                },
              },
            },
          },
        },
      },
    }),
    getEstuaryHttp,
  );
  app.post(
    "/v1/estuary/*",
    describeRoute({
      tags: ["Estuary"],
      summary: "Touch estuary",
      description: "Create or extend the TTL of an estuary stream.",
      responses: {
        200: {
          description: "Estuary touched",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  estuaryId: { type: "string" },
                  expiresAt: { type: "number" },
                },
              },
            },
          },
        },
      },
    }),
    touchEstuaryHttp,
  );
  app.delete(
    "/v1/estuary/*",
    describeRoute({
      tags: ["Estuary"],
      summary: "Delete estuary",
      description: "Delete an estuary and its underlying stream.",
      responses: {
        200: {
          description: "Estuary deleted",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  estuaryId: { type: "string" },
                  deleted: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    }),
    deleteEstuaryHttp,
  );

  // #region docs-route-to-do
  // Stream route — all pre/post-processing handled by middleware
  app.all(
    "/v1/stream/*",
    describeRoute({
      tags: ["Streams"],
      summary: "Stream operations",
      description:
        "Proxy to the stream Durable Object. PUT creates a stream, POST appends, GET reads (supports offset, cursor, long-poll, SSE, WebSocket), HEAD returns metadata, DELETE removes the stream.",
      responses: {
        200: { description: "Success — response varies by method and content type" },
        201: { description: "Stream created (PUT)" },
        204: { description: "Stream deleted or close-only append (DELETE / POST)" },
        304: { description: "Not modified (conditional GET with ETag)" },
        404: { description: "Stream not found" },
        409: { description: "Content-type mismatch or stream already exists" },
        413: { description: "Payload too large" },
      },
    }),
    // biome-ignore lint: Hono context typing is complex
    async (c: any) => {
      const doKey = c.get("streamPath");
      const stub = c.env.STREAMS.getByName(doKey);
      const doneOrigin = createTimer(c, "edge.origin");
      const response = await stub.routeStreamRequest(doKey, c.req.raw);
      doneOrigin();
      return response;
    },
  );
  // #endregion docs-route-to-do

  // 404 fallback
  app.all(
    "*",
    describeRoute({ hide: true }),
    // biome-ignore lint: Hono context typing is complex
    (c: any) => {
      return c.text("not found", 404, { "Cache-Control": "no-store" });
    },
  );

  // biome-ignore lint: Hono context typing is complex
  app.onError((err: Error, c: any) => {
    logError({ streamPath: c.get("streamPath"), method: c.req.method }, "unhandled error", err);
    return errorResponse(500, err.message ?? "internal error");
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
