import { Hono } from "hono";
import { getSession, touchSession } from "../../session";
import { createMetrics } from "../../metrics";
import type { CoreClientEnv } from "../../client";
import type { AnalyticsQueryEnv } from "../../analytics";

export interface SessionEnv {
  Bindings: CoreClientEnv &
    Partial<AnalyticsQueryEnv> & {
      SUBSCRIPTION_DO: DurableObjectNamespace;
      METRICS?: AnalyticsEngineDataset;
      ANALYTICS_DATASET?: string;
      SESSION_TTL_SECONDS?: string;
    };
}

export const sessionRoutes = new Hono<SessionEnv>();

sessionRoutes.get("/session/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = await getSession(c.env, sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json(session);
});

sessionRoutes.post("/session/:sessionId/touch", async (c) => {
  const sessionId = c.req.param("sessionId");
  try {
    return c.json(await touchSession(c.env, sessionId));
  } catch {
    return c.json({ error: "Session not found" }, 404);
  }
});

sessionRoutes.get("/internal/reconcile", async (c) => {
  const start = Date.now();
  const metrics = createMetrics(c.env.METRICS);
  const latencyMs = Date.now() - start;
  metrics.reconcile(0, 0, 0, 0, 0, latencyMs);

  return c.json({
    message:
      "Reconciliation is handled automatically in the new architecture. " +
      "Session streams in core are the source of truth. " +
      "Stale subscriptions are cleaned up lazily during fanout or by the cleanup cron.",
    totalSessions: 0,
    validSessions: 0,
    orphanedInD1: 0,
    cleaned: 0,
  });
});
