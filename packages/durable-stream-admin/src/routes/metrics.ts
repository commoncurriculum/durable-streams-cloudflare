import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  getStreamMetricsSummary,
  getTotalMetrics,
  getStreamMetrics,
  getTopStreams,
  getTimeline,
} from "../services/analytics";

export interface MetricsEnv {
  Bindings: {
    CF_ACCOUNT_ID?: string;
    METRICS_API_TOKEN?: string;
  };
}

const timeRangeSchema = z.object({
  range: z.enum(["1h", "24h", "7d"]).optional().default("24h"),
});

const topStreamsSchema = z.object({
  range: z.enum(["1h", "24h", "7d"]).optional().default("24h"),
  limit: z.coerce.number().int().min(1).max(100).optional().default(10),
});

const timelineSchema = z.object({
  range: z.enum(["1h", "24h", "7d"]).optional().default("24h"),
  interval: z.enum(["5m", "1h", "1d"]).optional().default("1h"),
});

export const metricsRoutes = new Hono<MetricsEnv>();

// GET /metrics/summary - Get summary metrics per stream
metricsRoutes.get("/metrics/summary", zValidator("query", timeRangeSchema), async (c) => {
  const { range } = c.req.valid("query");
  const result = await getStreamMetricsSummary(c.env, range);

  if (!result.success) {
    return c.json({ error: result.errors?.join(", ") }, 500);
  }

  return c.json(result.data);
});

// GET /metrics/totals - Get total metrics
metricsRoutes.get("/metrics/totals", zValidator("query", timeRangeSchema), async (c) => {
  const { range } = c.req.valid("query");
  const result = await getTotalMetrics(c.env, range);

  if (!result.success) {
    return c.json({ error: result.errors?.join(", ") }, 500);
  }

  return c.json(result.data);
});

// GET /metrics/streams/:streamId - Get metrics for a specific stream
metricsRoutes.get(
  "/metrics/streams/:streamId",
  zValidator("query", timeRangeSchema),
  async (c) => {
    const streamId = c.req.param("streamId");
    const { range } = c.req.valid("query");
    const result = await getStreamMetrics(c.env, streamId, range);

    if (!result.success) {
      return c.json({ error: result.errors?.join(", ") }, 500);
    }

    return c.json(result.data);
  },
);

// GET /metrics/top-streams - Get top N streams by message count
metricsRoutes.get("/metrics/top-streams", zValidator("query", topStreamsSchema), async (c) => {
  const { range, limit } = c.req.valid("query");
  const result = await getTopStreams(c.env, range, limit);

  if (!result.success) {
    return c.json({ error: result.errors?.join(", ") }, 500);
  }

  return c.json(result.data);
});

// GET /metrics/timeline - Get time-series data with fixed intervals
metricsRoutes.get("/metrics/timeline", zValidator("query", timelineSchema), async (c) => {
  const { range, interval } = c.req.valid("query");
  const result = await getTimeline(c.env, range, interval);

  if (!result.success) {
    return c.json({ error: result.errors?.join(", ") }, 500);
  }

  return c.json(result.data);
});
