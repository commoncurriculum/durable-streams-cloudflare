import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { EdgeBindings } from "../../hono/types";
import {
  listStreamsQuerySchema,
  streamIdParamSchema,
  listSegmentsQuerySchema,
} from "../../schemas/admin";

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

    // Get segment stats from segments_admin table
    const statsResult = await db
      .prepare(
        `SELECT
          COUNT(*) as segment_count,
          COALESCE(SUM(size_bytes), 0) as total_bytes,
          COALESCE(SUM(message_count), 0) as message_count
         FROM segments_admin WHERE stream_id = ?`
      )
      .bind(streamId)
      .first();

    // Get subscriber count from DO
    let subscriberCount = 0;
    const streams = c.env.STREAMS;
    if (streams) {
      try {
        const id = streams.idFromName(streamId);
        const stub = streams.get(id);
        const response = await stub.fetch(
          new Request("http://internal/internal/admin/subscribers", {
            method: "GET",
            headers: { "X-Stream-Id": streamId },
          })
        );
        if (response.ok) {
          const data = (await response.json()) as { count?: number };
          subscriberCount = data.count || 0;
        }
      } catch {
        // Ignore errors, keep subscriberCount at 0
      }
    }

    return c.json({
      streamId: result.stream_id as string,
      contentType: (result.content_type as string) || "application/octet-stream",
      closed: false,
      createdAt: result.created_at as number,
      expiresAt: null,
      segmentCount: statsResult ? (statsResult.segment_count as number) : 0,
      totalBytes: statsResult ? (statsResult.total_bytes as number) : 0,
      messageCount: statsResult ? (statsResult.message_count as number) : 0,
      subscriberCount,
    });
  });

  app.get(
    "/:streamId/segments",
    zValidator("param", streamIdParamSchema),
    zValidator("query", listSegmentsQuerySchema),
    async (c) => {
      const { streamId } = c.req.valid("param");
      const { limit, after } = c.req.valid("query");
      const db = c.env.ADMIN_DB;

      if (!db) {
        return c.json({ error: "ADMIN_DB not configured" }, 500);
      }

      const params: (string | number)[] = [streamId];
      let query = `SELECT
        stream_id, read_seq, start_offset, end_offset,
        r2_key, content_type, created_at, expires_at,
        size_bytes, message_count
       FROM segments_admin WHERE stream_id = ?`;

      if (after !== undefined) {
        query += ` AND read_seq > ?`;
        params.push(after);
      }

      query += ` ORDER BY read_seq ASC LIMIT ?`;
      params.push(limit + 1);

      const result = await db
        .prepare(query)
        .bind(...params)
        .all();
      const rows = result.results || [];

      const hasMore = rows.length > limit;
      const segments = rows.slice(0, limit).map((row) => ({
        streamId: row.stream_id as string,
        readSeq: row.read_seq as number,
        startOffset: row.start_offset as number,
        endOffset: row.end_offset as number,
        r2Key: row.r2_key as string,
        contentType: row.content_type as string,
        createdAt: row.created_at as number,
        expiresAt: row.expires_at as number | null,
        sizeBytes: row.size_bytes as number,
        messageCount: row.message_count as number,
      }));

      const nextCursor = hasMore ? segments[segments.length - 1]?.readSeq : undefined;

      return c.json({
        segments,
        nextCursor,
        hasMore,
      });
    }
  );

  return app;
}
