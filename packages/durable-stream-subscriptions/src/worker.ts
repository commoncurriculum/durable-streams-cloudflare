import { Hono } from "hono";
import { cors } from "hono/cors";
import { subscribeRoutes } from "./routes/subscribe";
import { publishRoutes } from "./routes/publish";
import { sessionRoutes } from "./routes/session";
import { cleanupExpiredSessions, type CleanupEnv } from "./cleanup";
import { processQueueBatch, type FanoutEnv, type FanoutMessage } from "./fanout";
import { createMetrics } from "./metrics";

export interface Env extends CleanupEnv {
  DB: D1Database;
  CORE_URL: string;
  AUTH_TOKEN?: string;
  SESSION_TTL_SECONDS?: string;
  FANOUT_QUEUE?: Queue<FanoutMessage>;
  FANOUT_THRESHOLD?: string;
  METRICS?: AnalyticsEngineDataset;
}

const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use(
  "*",
  cors({
    origin: "*",
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
  }),
);

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

  // Scheduled handler for session cleanup (two-phase: mark then delete)
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const start = Date.now();
        const result = await cleanupExpiredSessions(env);
        const latencyMs = Date.now() - start;

        // Record cleanup metrics
        const metrics = createMetrics(env.METRICS);
        metrics.cleanupBatch(
          result.marked,
          result.deleted,
          result.streamDeleteSuccesses,
          result.streamDeleteFailures,
          latencyMs,
        );

        if (result.marked > 0 || result.deleted > 0) {
          console.log(
            `Session cleanup: marked ${result.marked}, deleted ${result.deleted} ` +
              `(core: ${result.streamDeleteSuccesses} ok, ${result.streamDeleteFailures} failed)`,
          );
        }
      })().catch((err) => {
        console.error("Session cleanup failed:", err);
      }),
    );
  },

  // Queue handler for high-subscriber fanout
  async queue(batch: MessageBatch<FanoutMessage>, env: Env): Promise<void> {
    const start = Date.now();
    const result = await processQueueBatch(env, batch.messages);
    const latencyMs = Date.now() - start;

    // Record queue batch metrics
    const metrics = createMetrics(env.METRICS);
    metrics.queueBatch(result.processed, result.succeeded, result.retried, latencyMs);

    if (result.retried > 0) {
      console.log(
        `Queue batch processed: ${result.processed} messages, ${result.succeeded} succeeded, ${result.retried} retried`,
      );
    }
  },
};
