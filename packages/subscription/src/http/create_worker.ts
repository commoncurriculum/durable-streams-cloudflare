import { Hono } from "hono";
import { cors } from "hono/cors";
import { subscribeRoutes } from "./routes/subscribe";
import { publishRoutes } from "./routes/publish";
import { sessionRoutes } from "./routes/session";
import { cleanupExpiredSessions } from "../cleanup";
import { createMetrics } from "../metrics";
import { parseRoute } from "./auth";
import type { AppEnv } from "../env";
import type { AuthorizeSubscription } from "./auth";

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
        "X-Fanout-Count",
        "X-Fanout-Successes",
        "X-Fanout-Failures",
        "X-Stream-Next-Offset",
        "X-Stream-Up-To-Date",
        "X-Stream-Closed",
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

  // Mount routes
  app.route("/v1", subscribeRoutes);
  app.route("/v1", publishRoutes);
  app.route("/v1", sessionRoutes);

  // Catch-all
  app.all("*", (c) => {
    return c.json({ error: "Not found" }, 404);
  });

  // #region synced-to-docs:scheduled-handler
  return {
    fetch: app.fetch,

    // Scheduled handler for session cleanup
    async scheduled(event: ScheduledEvent, env: E, ctx: ExecutionContext): Promise<void> {
      ctx.waitUntil(
        (async () => {
          const start = Date.now();
          const result = await cleanupExpiredSessions(env);
          const latencyMs = Date.now() - start;

          // Record cleanup metrics
          const metrics = createMetrics(env.METRICS);
          metrics.cleanupBatch({
            expiredSessions: result.deleted,
            streamsDeleted: result.streamDeleteSuccesses,
            subscriptionsRemoved: result.subscriptionRemoveSuccesses,
            subscriptionsFailed: result.subscriptionRemoveFailures,
            latencyMs,
          });

          if (result.deleted > 0) {
            console.log(
              `Session cleanup: processed ${result.deleted} expired sessions ` +
                `(streams: ${result.streamDeleteSuccesses} ok, ${result.streamDeleteFailures} failed; ` +
                `subscriptions: ${result.subscriptionRemoveSuccesses} ok, ${result.subscriptionRemoveFailures} failed)`,
            );
          }
        })().catch((err) => {
          console.error("Session cleanup failed:", err);
        }),
      );
    },
  };
  // #endregion synced-to-docs:scheduled-handler
}
