import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { EdgeBindings } from "../../hono/types";
import { listStreamsQuerySchema, streamIdParamSchema } from "../../schemas/admin";

export function createAdminStreamsRoutes() {
  const app = new Hono<EdgeBindings>();

  app.get("/", zValidator("query", listStreamsQuerySchema), async (c) => {
    const { limit, cursor, prefix } = c.req.valid("query");
    const db = c.env.ADMIN_DB;

    if (!db) {
      return c.json({ error: "ADMIN_DB not configured" }, 500);
    }

    const params: (string | number)[] = [];
    let query = `SELECT stream_id, content_type, created_at FROM streams`;
    const conditions: string[] = [];

    if (prefix) {
      conditions.push(`stream_id LIKE ?`);
      params.push(`${prefix}%`);
    }

    if (cursor) {
      conditions.push(`stream_id > ?`);
      params.push(cursor);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(" AND ")}`;
    }

    query += ` ORDER BY stream_id ASC LIMIT ?`;
    params.push(limit + 1);

    const result = await db
      .prepare(query)
      .bind(...params)
      .all();
    const rows = result.results || [];

    const hasMore = rows.length > limit;
    const streams = rows.slice(0, limit).map((row) => ({
      streamId: row.stream_id as string,
      contentType: (row.content_type as string) || "application/octet-stream",
      closed: false,
      createdAt: row.created_at as number,
      expiresAt: null,
    }));

    const nextCursor = hasMore ? streams[streams.length - 1]?.streamId : undefined;

    return c.json({
      streams,
      nextCursor,
      hasMore,
    });
  });

  app.get("/:streamId", zValidator("param", streamIdParamSchema), async (c) => {
    const { streamId } = c.req.valid("param");
    const db = c.env.ADMIN_DB;

    if (!db) {
      return c.json({ error: "ADMIN_DB not configured" }, 500);
    }

    const result = await db
      .prepare(`SELECT stream_id, content_type, created_at FROM streams WHERE stream_id = ?`)
      .bind(streamId)
      .first();

    if (!result) {
      return c.json({ error: "stream not found" }, 404);
    }

    return c.json({
      streamId: result.stream_id as string,
      contentType: (result.content_type as string) || "application/octet-stream",
      closed: false,
      createdAt: result.created_at as number,
      expiresAt: null,
    });
  });

  return app;
}
