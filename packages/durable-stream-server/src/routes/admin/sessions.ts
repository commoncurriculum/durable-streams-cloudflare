import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { EdgeBindings } from "../../hono/types";
import { listSessionsQuerySchema } from "../../schemas/admin";
import { sessionIdParamSchema } from "../../schemas/subscriptions";

export function createAdminSessionsRoutes() {
  const app = new Hono<EdgeBindings>();

  app.get("/", zValidator("query", listSessionsQuerySchema), async (c) => {
    const { limit, cursor } = c.req.valid("query");
    const db = c.env.ADMIN_DB;

    if (!db) {
      return c.json({ error: "ADMIN_DB not configured" }, 500);
    }

    const params: (string | number)[] = [];
    let query = `SELECT session_id, created_at, expires_at FROM sessions`;

    if (cursor) {
      query += ` WHERE session_id > ?`;
      params.push(cursor);
    }

    query += ` ORDER BY session_id ASC LIMIT ?`;
    params.push(limit + 1);

    const result = await db
      .prepare(query)
      .bind(...params)
      .all();
    const rows = result.results || [];

    const hasMore = rows.length > limit;
    const sessions = rows.slice(0, limit).map((row) => ({
      sessionId: row.session_id as string,
      createdAt: row.created_at as number,
      expiresAt: row.expires_at as number,
      subscriptionCount: 0,
    }));

    const nextCursor = hasMore ? sessions[sessions.length - 1]?.sessionId : undefined;

    return c.json({
      sessions,
      nextCursor,
      hasMore,
    });
  });

  app.get("/:sessionId", zValidator("param", sessionIdParamSchema), async (c) => {
    const { sessionId } = c.req.valid("param");
    const db = c.env.ADMIN_DB;

    if (!db) {
      return c.json({ error: "ADMIN_DB not configured" }, 500);
    }

    const result = await db
      .prepare(`SELECT session_id, created_at, expires_at FROM sessions WHERE session_id = ?`)
      .bind(sessionId)
      .first();

    if (!result) {
      return c.json({ error: "session not found" }, 404);
    }

    // Get subscribed streams from session DO
    let subscribedStreams: string[] = [];
    const streams = c.env.STREAMS;
    if (streams) {
      try {
        // Session DOs use a different naming convention
        const id = streams.idFromName(`session:${sessionId}`);
        const stub = streams.get(id);
        const response = await stub.fetch(
          new Request("http://internal/internal/admin/subscriptions", { method: "GET" })
        );
        if (response.ok) {
          const data = (await response.json()) as { streams?: string[] };
          subscribedStreams = data.streams || [];
        }
      } catch {
        // Ignore errors, keep subscribedStreams empty
      }
    }

    return c.json({
      sessionId: result.session_id as string,
      createdAt: result.created_at as number,
      expiresAt: result.expires_at as number,
      subscriptionCount: subscribedStreams.length,
      subscribedStreams,
    });
  });

  return app;
}
