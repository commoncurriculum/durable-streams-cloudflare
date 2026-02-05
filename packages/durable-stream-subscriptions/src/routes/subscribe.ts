import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  createSession,
  getSession,
  addSubscription,
  removeSubscription,
  deleteSession,
  touchSession,
} from "../storage";
import {
  createSessionStreamWithEnv,
  deleteSessionStreamWithEnv,
  type FanoutEnv,
} from "../fanout";
import { createMetrics } from "../metrics";

export interface SubscribeEnv {
  Bindings: FanoutEnv & {
    SESSION_TTL_SECONDS?: string;
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

// POST /subscribe - Subscribe a session to a stream
subscribeRoutes.post("/subscribe", zValidator("json", subscribeSchema), async (c) => {
  const start = Date.now();
  const { sessionId, streamId, contentType } = c.req.valid("json");
  const db = c.env.DB;
  const metrics = createMetrics(c.env.METRICS);
  const ttlSeconds = c.env.SESSION_TTL_SECONDS
    ? Number.parseInt(c.env.SESSION_TTL_SECONDS, 10)
    : 1800;

  // Check if session exists in D1
  let session = await getSession(db, sessionId);
  const isNewSession = !session;

  if (isNewSession) {
    // Try core first - this is the source of truth for session streams
    // Core operation is idempotent (PUT with same ID returns 409 if exists)
    // Uses service binding if available for better performance
    const coreResponse = await createSessionStreamWithEnv(
      c.env,
      sessionId,
      contentType,
      ttlSeconds,
    );

    if (!coreResponse.ok && coreResponse.status !== 409) {
      // Core failed with non-conflict error - don't create D1 record
      const errorText = await coreResponse.text();
      console.error(`Failed to create session stream in core: ${coreResponse.status} - ${errorText}`);
      return c.json({ error: "Failed to create session stream" }, 500);
    }

    // Core succeeded (or stream already exists) - safe to create D1 record
    // D1 operation is also idempotent (ON CONFLICT DO UPDATE)
    await createSession(db, sessionId, ttlSeconds);
    session = await getSession(db, sessionId);

    // Record session creation metric
    metrics.sessionCreate(sessionId, ttlSeconds, Date.now() - start);
  } else {
    // Session exists - just touch it to update last_active_at
    await touchSession(db, sessionId);
  }

  // Add subscription (idempotent - ON CONFLICT DO NOTHING)
  await addSubscription(db, sessionId, streamId);

  // Record subscription metric
  const latencyMs = Date.now() - start;
  metrics.subscribe(streamId, sessionId, isNewSession, latencyMs);

  return c.json({
    sessionId,
    streamId,
    sessionStreamPath: `/v1/stream/session:${sessionId}`,
    expiresAt: session ? session.last_active_at + session.ttl_seconds * 1000 : null,
    isNewSession,
  });
});

// DELETE /unsubscribe - Unsubscribe a session from a stream
subscribeRoutes.delete("/unsubscribe", zValidator("json", unsubscribeSchema), async (c) => {
  const start = Date.now();
  const { sessionId, streamId } = c.req.valid("json");
  const db = c.env.DB;
  const metrics = createMetrics(c.env.METRICS);

  await removeSubscription(db, sessionId, streamId);

  // Record unsubscribe metric
  const latencyMs = Date.now() - start;
  metrics.unsubscribe(streamId, sessionId, latencyMs);

  return c.json({ sessionId, streamId, unsubscribed: true });
});

// DELETE /session/:sessionId - Delete a session entirely
subscribeRoutes.delete("/session/:sessionId", async (c) => {
  const start = Date.now();
  const sessionId = c.req.param("sessionId");
  const db = c.env.DB;
  const metrics = createMetrics(c.env.METRICS);

  // Delete session stream from core (uses service binding if available)
  await deleteSessionStreamWithEnv(c.env, sessionId).catch((err) => {
    console.error(`Failed to delete session stream ${sessionId}:`, err);
  });

  // Delete session and subscriptions from D1
  await deleteSession(db, sessionId);

  // Record session delete metric
  const latencyMs = Date.now() - start;
  metrics.sessionDelete(sessionId, latencyMs);

  return c.json({ sessionId, deleted: true });
});
