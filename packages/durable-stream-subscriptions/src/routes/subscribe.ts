import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createMetrics } from "../metrics";
import { fetchFromCore, type CoreClientEnv } from "../core-client";

export interface SubscribeEnv {
  Bindings: CoreClientEnv & {
    SUBSCRIPTION_DO: DurableObjectNamespace;
    SESSION_TTL_SECONDS?: string;
    METRICS?: AnalyticsEngineDataset;
  };
}

const subscribeSchema = z.object({
  sessionId: z.string().min(1),
  streamId: z.string().min(1),
  contentType: z.string().optional().default("application/json"),
});

const unsubscribeSchema = z.object({
  sessionId: z.string().min(1),
  streamId: z.string().min(1),
});

export const subscribeRoutes = new Hono<SubscribeEnv>();

/**
 * POST /subscribe - Subscribe a session to a stream.
 *
 * Flow:
 * 1. Create/touch session stream in core (source of truth for session streams)
 * 2. Add subscription to SubscriptionDO(streamId) for local subscriber lookup
 * 3. Record metrics
 */
subscribeRoutes.post("/subscribe", zValidator("json", subscribeSchema), async (c) => {
  const start = Date.now();
  const { sessionId, streamId, contentType } = c.req.valid("json");
  const metrics = createMetrics(c.env.METRICS);
  const ttlSeconds = c.env.SESSION_TTL_SECONDS
    ? Number.parseInt(c.env.SESSION_TTL_SECONDS, 10)
    : 1800;

  // 1. Create/touch session stream in core
  // This is the source of truth for session streams
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const coreResponse = await fetchFromCore(
    c.env,
    `/v1/stream/session:${sessionId}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "X-Stream-Expires-At": expiresAt.toString(),
      },
    },
  );

  const isNewSession = coreResponse.ok;

  if (!coreResponse.ok && coreResponse.status !== 409) {
    // Core failed with non-conflict error
    const errorText = await coreResponse.text();
    console.error(`Failed to create session stream in core: ${coreResponse.status} - ${errorText}`);
    return c.json({ error: "Failed to create session stream" }, 500);
  }

  // 2. Add subscription to SubscriptionDO(streamId)
  // Route to the DO for this stream - subscriber lookup is now local to the DO
  const doId = c.env.SUBSCRIPTION_DO.idFromName(streamId);
  const stub = c.env.SUBSCRIPTION_DO.get(doId);

  const doResponse = await stub.fetch(
    new Request("http://do/subscribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Stream-Id": streamId,
      },
      body: JSON.stringify({ sessionId }),
    }),
  );

  if (!doResponse.ok) {
    const errorText = await doResponse.text();
    console.error(`Failed to add subscription to DO: ${doResponse.status} - ${errorText}`);
    return c.json({ error: "Failed to add subscription" }, 500);
  }

  // 3. Record metrics
  const latencyMs = Date.now() - start;
  metrics.subscribe(streamId, sessionId, isNewSession, latencyMs);
  if (isNewSession) {
    metrics.sessionCreate(sessionId, ttlSeconds, latencyMs);
  }

  return c.json({
    sessionId,
    streamId,
    sessionStreamPath: `/v1/stream/session:${sessionId}`,
    expiresAt,
    isNewSession,
  });
});

/**
 * DELETE /unsubscribe - Unsubscribe a session from a stream.
 *
 * Flow:
 * 1. Remove subscription from SubscriptionDO(streamId)
 * 2. Record metrics
 */
subscribeRoutes.delete("/unsubscribe", zValidator("json", unsubscribeSchema), async (c) => {
  const start = Date.now();
  const { sessionId, streamId } = c.req.valid("json");
  const metrics = createMetrics(c.env.METRICS);

  // Route to SubscriptionDO(streamId) to remove subscriber
  const doId = c.env.SUBSCRIPTION_DO.idFromName(streamId);
  const stub = c.env.SUBSCRIPTION_DO.get(doId);

  const doResponse = await stub.fetch(
    new Request("http://do/unsubscribe", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "X-Stream-Id": streamId,
      },
      body: JSON.stringify({ sessionId }),
    }),
  );

  if (!doResponse.ok) {
    const errorText = await doResponse.text();
    console.error(`Failed to remove subscription from DO: ${doResponse.status} - ${errorText}`);
    return c.json({ error: "Failed to remove subscription" }, 500);
  }

  // Record metrics
  const latencyMs = Date.now() - start;
  metrics.unsubscribe(streamId, sessionId, latencyMs);

  return c.json({ sessionId, streamId, unsubscribed: true });
});

/**
 * DELETE /session/:sessionId - Delete a session entirely.
 *
 * Flow:
 * 1. Delete session stream from core
 * 2. Note: Subscriptions in SubscriptionDOs will be cleaned up by the cleanup cron
 *    when it detects that the session stream no longer exists in core.
 *    This is the "eventually consistent" approach - subscriptions are removed lazily.
 */
subscribeRoutes.delete("/session/:sessionId", async (c) => {
  const start = Date.now();
  const sessionId = c.req.param("sessionId");
  const metrics = createMetrics(c.env.METRICS);

  // Delete session stream from core
  try {
    const response = await fetchFromCore(c.env, `/v1/stream/session:${sessionId}`, {
      method: "DELETE",
    });

    // 404 is acceptable - session already deleted
    if (!response.ok && response.status !== 404) {
      const errorText = await response.text();
      console.error(`Failed to delete session stream ${sessionId}: ${response.status} - ${errorText}`);
      return c.json({ error: "Failed to delete session stream" }, 500);
    }
  } catch (err) {
    console.error(`Failed to delete session stream ${sessionId}:`, err);
    return c.json({ error: "Failed to delete session stream" }, 500);
  }

  // Record metrics
  const latencyMs = Date.now() - start;
  metrics.sessionDelete(sessionId, latencyMs);

  // Note: Subscriptions in SubscriptionDOs are cleaned up lazily by the cleanup cron
  // when it detects that writes to the session stream fail with 404.

  return c.json({ sessionId, deleted: true });
});
