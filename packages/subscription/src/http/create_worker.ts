import { Hono } from "hono";
import { cors } from "hono/cors";
import { subscribeRoutes } from "./routes/subscribe";
import { publishRoutes } from "./routes/publish";
import { sessionRoutes } from "./routes/session";
import { handleFanoutQueue } from "../queue/fanout-consumer";
import { createMetrics } from "../metrics";
import { parseRoute } from "./auth";
import { isValidProjectId } from "../constants";
import type { AppEnv } from "../env";
import type { AuthorizeSubscription } from "./auth";
import type { FanoutQueueMessage } from "../subscriptions/types";

export interface SubscriptionWorkerConfig<E extends AppEnv = AppEnv> {
  authorize?: AuthorizeSubscription<E>;
}

/**
 * Parse CORS_ORIGINS env var into origin configuration.
 * - undefined or empty: allow all ("*")
 * - "*": allow all
 * - "https://example.com": single origin
 * - "https://a.com,https://b.com": multiple origins
 */
function parseCorsOrigins(
  corsOrigins: string | undefined,
): string | string[] | ((origin: string) => string | undefined | null) {
  if (!corsOrigins || corsOrigins === "*") {
    return "*";
  }

  const origins = corsOrigins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  if (origins.length === 1) {
    return origins[0];
  }

  // Multiple origins: return a function that validates
  return (origin: string) => {
    if (origins.includes(origin)) {
      return origin;
    }
    return null;
  };
}

// #region synced-to-docs:worker-entry
export function createSubscriptionWorker<E extends AppEnv = AppEnv>(
  config?: SubscriptionWorkerConfig<E>,
) {
  const app = new Hono<{ Bindings: E }>();
  // #endregion synced-to-docs:worker-entry

  // #region synced-to-docs:middleware
  // CORS middleware
  app.use("*", async (c, next) => {
    const corsOrigin = parseCorsOrigins(c.env.CORS_ORIGINS);
    const corsMiddleware = cors({
      origin: corsOrigin,
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-Session-Id",
        "Producer-Id",
        "Producer-Epoch",
        "Producer-Seq",
      ],
      exposeHeaders: [
        "Stream-Fanout-Count",
        "Stream-Fanout-Successes",
        "Stream-Fanout-Failures",
        "Stream-Fanout-Mode",
        "Stream-Next-Offset",
        "Stream-Up-To-Date",
        "Stream-Closed",
      ],
    });
    return corsMiddleware(c, next);
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

  // Validate project ID before hitting routes
  app.use("/v1/:project/*", async (c, next) => {
    const project = c.req.param("project");
    if (!project || !isValidProjectId(project)) {
      return c.json({ error: "Invalid project ID" }, 400);
    }
    return next();
  });

  // Mount routes under /v1/:project
  app.route("/v1/:project", subscribeRoutes);
  app.route("/v1/:project", publishRoutes);
  app.route("/v1/:project", sessionRoutes);

  // Catch-all
  app.all("*", (c) => {
    return c.json({ error: "Not found" }, 404);
  });

  return {
    fetch: app.fetch,

    // Queue handler for async fanout
    async queue(batch: MessageBatch<FanoutQueueMessage>, env: E, _ctx: ExecutionContext): Promise<void> {
      await handleFanoutQueue(batch, env);
    },
  };
}
