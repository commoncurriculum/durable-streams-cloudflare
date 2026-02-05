import { Hono } from "hono";
import {
  getSession,
  getSessionSubscriptions,
  touchSession,
  getAllSessions,
  deleteSession,
} from "../storage";
import { type FanoutEnv } from "../fanout";
import { createMetrics } from "../metrics";
import { fetchFromCore } from "../core-client";

export interface SessionEnv {
  Bindings: FanoutEnv;
}

export const sessionRoutes = new Hono<SessionEnv>();

// GET /session/:sessionId - Get session info and subscriptions
sessionRoutes.get("/session/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const db = c.env.DB;

  const session = await getSession(db, sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const subscriptions = await getSessionSubscriptions(db, sessionId);

  return c.json({
    sessionId: session.session_id,
    createdAt: session.created_at,
    lastActiveAt: session.last_active_at,
    ttlSeconds: session.ttl_seconds,
    expiresAt: session.last_active_at + session.ttl_seconds * 1000,
    sessionStreamPath: `/v1/stream/session:${sessionId}`,
    subscriptions: subscriptions.map((s) => ({
      streamId: s.stream_id,
      subscribedAt: s.subscribed_at,
    })),
  });
});

// POST /session/:sessionId/touch - Touch session to extend TTL
sessionRoutes.post("/session/:sessionId/touch", async (c) => {
  const start = Date.now();
  const sessionId = c.req.param("sessionId");
  const db = c.env.DB;
  const metrics = createMetrics(c.env.METRICS);

  const updated = await touchSession(db, sessionId);
  if (!updated) {
    return c.json({ error: "Session not found" }, 404);
  }

  const session = await getSession(db, sessionId);

  // Record session touch metric
  const latencyMs = Date.now() - start;
  metrics.sessionTouch(sessionId, latencyMs);

  return c.json({
    sessionId,
    lastActiveAt: session?.last_active_at,
    expiresAt: session ? session.last_active_at + session.ttl_seconds * 1000 : null,
  });
});

// GET /internal/reconcile - Compare D1 sessions with core streams and clean up orphans
// This endpoint is intended to be called periodically or on-demand
sessionRoutes.get("/internal/reconcile", async (c) => {
  const start = Date.now();
  const db = c.env.DB;
  const metrics = createMetrics(c.env.METRICS);

  const sessions = await getAllSessions(db);

  const orphanedInD1: string[] = [];
  const validSessions: string[] = [];
  const errors: string[] = [];

  // Check each D1 session against core (uses service binding if available)
  for (const session of sessions) {
    const streamPath = `/v1/stream/session:${session.session_id}`;
    try {
      const response = await fetchFromCore(c.env, streamPath, { method: "HEAD" });

      if (response.status === 404) {
        // Stream doesn't exist in core - D1 record is orphaned
        orphanedInD1.push(session.session_id);
      } else if (response.ok) {
        validSessions.push(session.session_id);
      } else {
        errors.push(`${session.session_id}: ${response.status}`);
      }
    } catch (err) {
      errors.push(`${session.session_id}: ${err}`);
    }
  }

  // Optionally clean up orphaned D1 records
  const cleanup = c.req.query("cleanup") === "true";
  let cleaned = 0;

  if (cleanup && orphanedInD1.length > 0) {
    for (const sessionId of orphanedInD1) {
      try {
        await deleteSession(db, sessionId);
        cleaned++;
      } catch (err) {
        errors.push(`cleanup ${sessionId}: ${err}`);
      }
    }
  }

  // Record reconciliation metrics
  const latencyMs = Date.now() - start;
  metrics.reconcile(
    sessions.length,
    validSessions.length,
    orphanedInD1.length,
    cleaned,
    errors.length,
    latencyMs,
  );

  return c.json({
    totalSessions: sessions.length,
    validSessions: validSessions.length,
    orphanedInD1: orphanedInD1.length,
    orphanedSessionIds: orphanedInD1,
    cleaned,
    errors: errors.length > 0 ? errors : undefined,
  });
});
