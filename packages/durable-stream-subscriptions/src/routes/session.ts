import { Hono } from "hono";
import { createMetrics } from "../metrics";
import { fetchFromCore, type CoreClientEnv } from "../core-client";
import {
  getSessionSubscriptions,
  type AnalyticsQueryEnv,
} from "../analytics-queries";

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

/**
 * GET /session/:sessionId - Get session info and subscriptions.
 *
 * Checks if session stream exists in core and queries Analytics Engine
 * for subscription data.
 */
sessionRoutes.get("/session/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");

  // Check if session stream exists in core (HEAD request)
  const coreResponse = await fetchFromCore(
    c.env,
    `/v1/stream/session:${sessionId}`,
    { method: "HEAD" },
  );

  if (!coreResponse.ok) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Get subscriptions from Analytics Engine (if configured)
  let subscriptions: Array<{ streamId: string }> = [];

  if (c.env.ACCOUNT_ID && c.env.API_TOKEN) {
    const analyticsEnv = {
      ACCOUNT_ID: c.env.ACCOUNT_ID,
      API_TOKEN: c.env.API_TOKEN,
    };
    const datasetName = c.env.ANALYTICS_DATASET ?? "subscriptions_metrics";

    try {
      subscriptions = await getSessionSubscriptions(analyticsEnv, datasetName, sessionId);
    } catch (err) {
      console.error("Failed to query subscriptions from Analytics Engine:", err);
      // Continue without subscription data
    }
  }

  return c.json({
    sessionId,
    sessionStreamPath: `/v1/stream/session:${sessionId}`,
    subscriptions: subscriptions.map((s) => ({
      streamId: s.streamId,
    })),
  });
});

/**
 * POST /session/:sessionId/touch - Touch session to extend TTL.
 *
 * In the new architecture, session TTL is managed by the core stream's
 * X-Stream-Expires-At header. Touching refreshes this expiry.
 */
sessionRoutes.post("/session/:sessionId/touch", async (c) => {
  const start = Date.now();
  const sessionId = c.req.param("sessionId");
  const metrics = createMetrics(c.env.METRICS);

  // Get TTL from env (default 30 minutes)
  const ttlSeconds = c.env.SESSION_TTL_SECONDS
    ? Number.parseInt(c.env.SESSION_TTL_SECONDS as string, 10)
    : 1800;
  const expiresAt = Date.now() + ttlSeconds * 1000;

  // Touch by doing a PUT with updated expiry
  // Core handles this idempotently - returns 409 if exists, which is fine
  const coreResponse = await fetchFromCore(
    c.env,
    `/v1/stream/session:${sessionId}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Stream-Expires-At": expiresAt.toString(),
      },
    },
  );

  if (!coreResponse.ok && coreResponse.status !== 409) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Record session touch metric
  const latencyMs = Date.now() - start;
  metrics.sessionTouch(sessionId, latencyMs);

  return c.json({
    sessionId,
    expiresAt,
  });
});

/**
 * GET /internal/reconcile - Reconciliation endpoint.
 *
 * In the new architecture, reconciliation is less critical because:
 * - Session streams are the source of truth (in core)
 * - Subscriptions are stored per-stream in SubscriptionDOs
 * - Stale subscriptions are cleaned up lazily during fanout or by cleanup cron
 *
 * This endpoint can still check for orphaned data if needed.
 */
sessionRoutes.get("/internal/reconcile", async (c) => {
  const start = Date.now();
  const metrics = createMetrics(c.env.METRICS);

  // In the new architecture, there's no central D1 to reconcile against.
  // The session streams in core are the source of truth.
  // SubscriptionDOs clean up stale subscribers during fanout (404 response).

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
