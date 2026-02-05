import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { EdgeBindings } from "../../hono/types";
import {
  getHotStreams,
  getStreamThroughput,
  getActiveSubscribers,
  getSystemThroughput,
  getTotalActiveSubscribers,
} from "../../services/analytics";
import { getQueueLatencyMetrics } from "../../services/queue-metrics";

const streamIdParamSchema = z.object({
  streamId: z.string().min(1),
});

const throughputQuerySchema = z.object({
  minutes: z.coerce.number().int().min(1).max(1440).optional().default(60),
});

const hotStreamsQuerySchema = z.object({
  minutes: z.coerce.number().int().min(1).max(60).optional().default(5),
  limit: z.coerce.number().int().min(1).max(100).optional().default(10),
});

const queueLatencyQuerySchema = z.object({
  minutes: z.coerce.number().int().min(1).max(1440).optional().default(60),
});

export function createAdminMetricsRoutes() {
  const app = new Hono<EdgeBindings>();

  // Check if metrics are configured
  const checkMetricsConfig = (c: {
    env: { CF_ACCOUNT_ID?: string; METRICS_API_TOKEN?: string };
  }): { accountId: string; apiToken: string } | null => {
    const accountId = c.env.CF_ACCOUNT_ID;
    const apiToken = c.env.METRICS_API_TOKEN;
    if (!accountId || !apiToken) {
      return null;
    }
    return { accountId, apiToken };
  };

  /**
   * GET /hot - Top streams by message volume
   */
  app.get("/hot", zValidator("query", hotStreamsQuerySchema), async (c) => {
    const config = checkMetricsConfig(c);
    if (!config) {
      return c.json({ error: "Metrics not configured" }, 503);
    }

    const { minutes, limit } = c.req.valid("query");

    try {
      const streams = await getHotStreams(config.accountId, config.apiToken, {
        minutes,
        limit,
      });

      return c.json({
        streams: streams.map((s) => ({
          streamId: s.stream_id,
          messageCount: Math.round(s.message_count),
          byteCount: Math.round(s.byte_count),
        })),
        periodMinutes: minutes,
      });
    } catch (error) {
      console.error("Failed to fetch hot streams:", error);
      return c.json({ error: "Failed to fetch metrics" }, 500);
    }
  });

  /**
   * GET /system - System-wide throughput stats
   */
  app.get("/system", async (c) => {
    const config = checkMetricsConfig(c);
    if (!config) {
      return c.json({ error: "Metrics not configured" }, 503);
    }

    try {
      const [throughput, subscribers] = await Promise.all([
        getSystemThroughput(config.accountId, config.apiToken, { minutes: 5 }),
        getTotalActiveSubscribers(config.accountId, config.apiToken),
      ]);

      return c.json({
        messagesLast5Min: Math.round(throughput.total_messages),
        bytesLast5Min: Math.round(throughput.total_bytes),
        messagesPerSecond: Math.round(throughput.total_messages / 300),
        activeSubscribers: Math.round(subscribers),
      });
    } catch (error) {
      console.error("Failed to fetch system metrics:", error);
      return c.json({ error: "Failed to fetch metrics" }, 500);
    }
  });

  /**
   * GET /streams/:streamId/throughput - Per-stream throughput over time
   */
  app.get(
    "/streams/:streamId/throughput",
    zValidator("param", streamIdParamSchema),
    zValidator("query", throughputQuerySchema),
    async (c) => {
      const config = checkMetricsConfig(c);
      if (!config) {
        return c.json({ error: "Metrics not configured" }, 503);
      }

      const { streamId } = c.req.valid("param");
      const { minutes } = c.req.valid("query");

      try {
        const buckets = await getStreamThroughput(
          config.accountId,
          config.apiToken,
          streamId,
          { minutes }
        );

        // Calculate average messages per minute
        const totalMessages = buckets.reduce((sum, b) => sum + b.messages, 0);
        const avgMessagesPerMinute =
          buckets.length > 0 ? totalMessages / buckets.length : 0;

        return c.json({
          streamId,
          buckets: buckets.map((b) => ({
            timestamp: b.minute * 1000,
            messages: Math.round(b.messages),
            bytes: Math.round(b.bytes),
          })),
          avgMessagesPerMinute: Math.round(avgMessagesPerMinute * 100) / 100,
          periodMinutes: minutes,
        });
      } catch (error) {
        console.error("Failed to fetch stream throughput:", error);
        return c.json({ error: "Failed to fetch metrics" }, 500);
      }
    }
  );

  /**
   * GET /streams/:streamId/subscribers - Active subscriber count for a stream
   */
  app.get(
    "/streams/:streamId/subscribers",
    zValidator("param", streamIdParamSchema),
    async (c) => {
      const config = checkMetricsConfig(c);
      if (!config) {
        return c.json({ error: "Metrics not configured" }, 503);
      }

      const { streamId } = c.req.valid("param");

      try {
        const count = await getActiveSubscribers(
          config.accountId,
          config.apiToken,
          streamId
        );

        return c.json({
          streamId,
          activeSubscribers: Math.round(count),
        });
      } catch (error) {
        console.error("Failed to fetch subscriber count:", error);
        return c.json({ error: "Failed to fetch metrics" }, 500);
      }
    }
  );

  /**
   * GET /queue/latency - Queue latency metrics from Cloudflare Queues
   */
  app.get(
    "/queue/latency",
    zValidator("query", queueLatencyQuerySchema),
    async (c) => {
      const config = checkMetricsConfig(c);
      if (!config) {
        return c.json({ error: "Metrics not configured" }, 503);
      }

      // Queue name from wrangler.toml binding - the API will look up the UUID
      const queueName = "durable-streams-fanout-queue";

      const { minutes } = c.req.valid("query");

      try {
        const metrics = await getQueueLatencyMetrics(
          config.accountId,
          config.apiToken,
          queueName,
          { minutes }
        );

        return c.json(metrics);
      } catch (error) {
        console.error("Failed to fetch queue latency metrics:", error);
        return c.json({ error: "Failed to fetch queue metrics" }, 500);
      }
    }
  );

  return app;
}
