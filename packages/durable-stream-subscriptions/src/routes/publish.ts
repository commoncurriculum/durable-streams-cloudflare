import { Hono } from "hono";
import { createMetrics } from "../metrics";
import type { CoreClientEnv } from "../core-client";

export interface PublishEnv {
  Bindings: CoreClientEnv & {
    SUBSCRIPTION_DO: DurableObjectNamespace;
    METRICS?: AnalyticsEngineDataset;
  };
}

export const publishRoutes = new Hono<PublishEnv>();

/**
 * POST /publish/:streamId - Publish to a stream and fan out to subscribers.
 *
 * Routes to SubscriptionDO(streamId) which handles:
 * 1. Write to core stream (source of truth)
 * 2. Look up subscribers (LOCAL SQLite query - no D1!)
 * 3. Fan out to all subscriber session streams
 */
publishRoutes.post("/publish/:streamId", async (c) => {
  const start = Date.now();
  const streamId = c.req.param("streamId");
  const contentType = c.req.header("Content-Type") ?? "application/json";
  const metrics = createMetrics(c.env.METRICS);

  // Route to SubscriptionDO(streamId) - it handles write + fanout
  const doId = c.env.SUBSCRIPTION_DO.idFromName(streamId);
  const stub = c.env.SUBSCRIPTION_DO.get(doId);

  // Clone the request and forward to DO
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "X-Stream-Id": streamId,
  };

  // Pass through producer headers for deduplication
  const producerId = c.req.header("Producer-Id");
  const producerEpoch = c.req.header("Producer-Epoch");
  const producerSeq = c.req.header("Producer-Seq");

  if (producerId) headers["Producer-Id"] = producerId;
  if (producerEpoch) headers["Producer-Epoch"] = producerEpoch;
  if (producerSeq) headers["Producer-Seq"] = producerSeq;

  // Read the body as ArrayBuffer to avoid streaming issues
  const body = await c.req.arrayBuffer();

  const doResponse = await stub.fetch(
    new Request("http://do/publish", {
      method: "POST",
      headers,
      body,
    }),
  );

  // Record latency metric (fanout metrics recorded by DO)
  const latencyMs = Date.now() - start;

  if (!doResponse.ok) {
    metrics.publishError(streamId, `http_${doResponse.status}`, latencyMs);
  }

  // Return DO response with headers
  return new Response(doResponse.body, {
    status: doResponse.status,
    headers: doResponse.headers,
  });
});
