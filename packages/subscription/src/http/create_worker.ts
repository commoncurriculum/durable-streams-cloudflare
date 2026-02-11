import { Hono } from "hono";
import { subscribeRoutes } from "./routes/subscribe";
import { publishRoutes } from "./routes/publish";
import { estuaryRoutes } from "./routes/estuary";
import { handleFanoutQueue } from "../queue/fanout-consumer";
import { createMetrics } from "../metrics";
import { parseRoute, lookupProjectConfig } from "./auth";
import { isValidProjectId } from "../constants";
import type { AppEnv } from "../env";
import type { AuthorizeSubscription } from "./auth";
import type { FanoutQueueMessage } from "../subscriptions/types";

export interface SubscriptionWorkerConfig<E extends AppEnv = AppEnv> {
  authorize?: AuthorizeSubscription<E>;
}

const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Estuary-Id",
  "Producer-Id",
  "Producer-Epoch",
  "Producer-Seq",
].join(", ");

const CORS_EXPOSE_HEADERS = [
  "Stream-Fanout-Count",
  "Stream-Fanout-Successes",
  "Stream-Fanout-Failures",
  "Stream-Fanout-Mode",
  "Stream-Next-Offset",
  "Stream-Up-To-Date",
  "Stream-Closed",
].join(", ");

/**
 * Resolve the CORS origin for a request from per-project config.
 * Returns null (no CORS headers) when no corsOrigins are configured.
 */
function resolveProjectCorsOrigin(
  corsOrigins: string[] | undefined,
  requestOrigin: string | null
): string | null {
  if (!corsOrigins || corsOrigins.length === 0) return null;
  if (corsOrigins.includes("*")) return "*";
  if (requestOrigin && corsOrigins.includes(requestOrigin))
    return requestOrigin;
  return null;
}

function applyCorsHeaders(headers: Headers, origin: string | null): void {
  if (origin === null) return;
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  headers.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);
}

/** Extract projectId from /v1/estuary/.../:projectId/... paths */
const PROJECT_PATH_RE = /^\/v1\/estuary\/(?:publish|subscribe)\/([^/]+)\//;
const PROJECT_PATH_DIRECT_RE = /^\/v1\/estuary\/([^/]+)\//;

function extractProjectId(pathname: string): string | null {
  // Try 5-segment paths first: /v1/estuary/publish|subscribe/:projectId/:id
  const actionMatch = PROJECT_PATH_RE.exec(pathname);
  if (actionMatch) return actionMatch[1];
  // Then 4-segment paths: /v1/estuary/:projectId/:estuaryId
  const directMatch = PROJECT_PATH_DIRECT_RE.exec(pathname);
  if (directMatch) return directMatch[1];
  return null;
}

// #region synced-to-docs:worker-entry
export function createSubscriptionWorker<E extends AppEnv = AppEnv>(
  config?: SubscriptionWorkerConfig<E>
) {
  const app = new Hono<{ Bindings: E }>();
  // #endregion synced-to-docs:worker-entry

  // #region synced-to-docs:middleware
  // Per-project CORS middleware — looks up corsOrigins from KV
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const projectId = extractProjectId(url.pathname);

    let corsOrigin: string | null = null;

    if (projectId && c.env.REGISTRY) {
      if (isValidProjectId(projectId)) {
        const projectConfig = await lookupProjectConfig(
          c.env.REGISTRY,
          projectId
        );
        corsOrigin = resolveProjectCorsOrigin(
          projectConfig?.corsOrigins,
          c.req.header("Origin") ?? null
        );
      }
    }

    // Handle OPTIONS preflight
    if (c.req.method === "OPTIONS") {
      const headers = new Headers();
      applyCorsHeaders(headers, corsOrigin);
      return new Response(null, { status: 204, headers });
    }

    // Store corsOrigin for after-response header injection
    await next();

    // Apply CORS headers to the response
    applyCorsHeaders(c.res.headers, corsOrigin);
  });

  // Auth middleware — skips /health and runs only when authorize is configured
  if (config?.authorize) {
    const authorize = config.authorize;
    app.use("*", async (c, next) => {
      const url = new URL(c.req.url);
      if (url.pathname === "/health") return next();

      const route = await parseRoute(c.req.method, url.pathname, c.req.raw);
      if (!route) return next(); // Unknown route — let Hono handle 404/400

      const result = await authorize(c.req.raw, route, c.env);
      if (!result.ok) return result.response;
      return next();
    });
  }

  // HTTP metrics middleware
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const latencyMs = Date.now() - start;

    const metrics = createMetrics(c.env.METRICS);
    const path = new URL(c.req.url).pathname;
    metrics.http(path, c.req.method, c.res.status, latencyMs);
  });
  // #endregion synced-to-docs:middleware

  // Health check
  app.get("/health", (c) => {
    return c.json({ status: "ok" });
  });

  // Project ID validation middleware for /v1/estuary/* routes
  app.use("/v1/estuary/*", async (c, next) => {
    const url = new URL(c.req.url);
    const projectId = extractProjectId(url.pathname);
    if (projectId && !isValidProjectId(projectId)) {
      return c.json({ error: "Invalid project ID" }, 400);
    }
    return next();
  });

  // Mount routes under /v1/estuary
  // Order matters: subscribe and publish (5-segment) before estuary (4-segment catch-all)
  app.route("/v1/estuary", subscribeRoutes);
  app.route("/v1/estuary", publishRoutes);
  app.route("/v1/estuary", estuaryRoutes);

  // Catch-all
  app.all("*", (c) => {
    return c.json({ error: "Not found" }, 404);
  });

  return {
    fetch: app.fetch,

    // Queue handler for async fanout
    async queue(
      batch: MessageBatch<FanoutQueueMessage>,
      env: E,
      _ctx: ExecutionContext
    ): Promise<void> {
      await handleFanoutQueue(batch, env);
    },
  };
}
