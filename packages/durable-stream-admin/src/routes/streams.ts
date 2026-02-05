import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { listStreams, getStream, getStreamSegments, getStreamStats } from "../services/d1";
import { fetchFromCore, type CoreClientEnv } from "../core-client";

export interface StreamsEnv {
  Bindings: CoreClientEnv & {
    ADMIN_DB: D1Database;
  };
}

const listQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(1000).optional().default(100),
  offset: z.coerce.number().min(0).optional().default(0),
  includeDeleted: z.enum(["true", "false"]).optional().default("false"),
});

export const streamsRoutes = new Hono<StreamsEnv>();

// GET /streams - List all streams
streamsRoutes.get("/streams", zValidator("query", listQuerySchema), async (c) => {
  const { limit, offset, includeDeleted } = c.req.valid("query");

  const { streams, total } = await listStreams(c.env.ADMIN_DB, {
    limit,
    offset,
    includeDeleted: includeDeleted === "true",
  });

  return c.json({
    streams,
    total,
    limit,
    offset,
    hasMore: offset + streams.length < total,
  });
});

// GET /streams/stats - Get aggregate stats
streamsRoutes.get("/streams/stats", async (c) => {
  const stats = await getStreamStats(c.env.ADMIN_DB);
  return c.json(stats);
});

// GET /streams/:streamId - Get stream details
streamsRoutes.get("/streams/:streamId", async (c) => {
  const streamId = c.req.param("streamId");

  // Get stream from D1
  const stream = await getStream(c.env.ADMIN_DB, streamId);
  if (!stream) {
    return c.json({ error: "Stream not found in registry" }, 404);
  }

  // Get live config from core (using service binding if available)
  let liveConfig = null;
  try {
    const response = await fetchFromCore(
      c.env,
      `/v1/stream/${streamId}/internal/admin/config`,
    );
    if (response.ok) {
      liveConfig = await response.json();
    }
  } catch {
    // Core might not be reachable
  }

  return c.json({
    ...stream,
    liveConfig,
  });
});

// GET /streams/:streamId/segments - Get stream segments
streamsRoutes.get("/streams/:streamId/segments", async (c) => {
  const streamId = c.req.param("streamId");
  const segments = await getStreamSegments(c.env.ADMIN_DB, streamId);
  return c.json({ streamId, segments });
});
