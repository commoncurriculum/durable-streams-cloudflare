import { Hono } from "hono";
import { cors } from "hono/cors";
import { subscribeRoutes } from "./routes/subscribe";
import { publishRoutes } from "./routes/publish";
import { sessionRoutes } from "./routes/session";
import { cleanupExpiredSessions } from "./cleanup";
import { createMetrics } from "./metrics";
import { SubscriptionDO } from "./subscription_do";

export { SubscriptionDO };

export interface Env {
  SUBSCRIPTION_DO: DurableObjectNamespace;
  CORE?: Fetcher;
  CORE_URL: string;
  AUTH_TOKEN?: string;
  SESSION_TTL_SECONDS?: string;
  METRICS?: AnalyticsEngineDataset;
  // Required for Analytics Engine SQL queries (cleanup)
  ACCOUNT_ID?: string;
  API_TOKEN?: string;
  ANALYTICS_DATASET?: string;
  // CORS configuration: comma-separated origins or "*" for all
  CORS_ORIGINS?: string;
}

const app = new Hono<{ Bindings: Env }>();

/**
 * Parse CORS_ORIGINS env var into origin configuration.
 * - undefined or empty: allow all ("*")
 * - "*": allow all
 * - "https://example.com": single origin
 * - "https://a.com,https://b.com": multiple origins
 */
function parseCorsOrigins(corsOrigins: string | undefined): string | string[] | ((origin: string) => string | undefined | null) {
  if (!corsOrigins || corsOrigins === "*") {
    return "*";
  }

  const origins = corsOrigins.split(",").map((o) => o.trim()).filter(Boolean);

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

// Optional bearer auth middleware
app.use("*", async (c, next) => {
  const expectedToken = c.env.AUTH_TOKEN;
  if (!expectedToken) {
    return next();
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const token = authHeader.slice(7);
  if (token !== expectedToken) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return next();
});

// HTTP metrics middleware
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const latencyMs = Date.now() - start;

  const metrics = createMetrics(c.env.METRICS);
  const path = new URL(c.req.url).pathname;
  metrics.http(path, c.req.method, c.res.status, latencyMs);
});

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

export default {
  fetch: app.fetch,

  // Scheduled handler for session cleanup
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const start = Date.now();
        const result = await cleanupExpiredSessions(env);
        const latencyMs = Date.now() - start;

        // Record cleanup metrics
        // Note: cleanupBatch params are (expiredCount, streamsDeleted, subscriptionsRemoved, subscriptionsFailed, latencyMs)
        const metrics = createMetrics(env.METRICS);
        metrics.cleanupBatch(
          result.deleted,
          result.streamDeleteSuccesses,
          result.subscriptionRemoveSuccesses,
          result.subscriptionRemoveFailures,
          latencyMs,
        );

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
