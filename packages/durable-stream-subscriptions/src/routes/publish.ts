import { Hono } from "hono";
import { fanOutToSubscribers, type FanoutEnv } from "../fanout";
import { createMetrics } from "../metrics";
import { fetchFromCore } from "../core-client";

export interface PublishEnv {
  Bindings: FanoutEnv;
}

export const publishRoutes = new Hono<PublishEnv>();

// POST /publish/:streamId - Publish to a stream and fan out to subscribers
publishRoutes.post("/publish/:streamId", async (c) => {
  const start = Date.now();
  const streamId = c.req.param("streamId");
  const contentType = c.req.header("Content-Type") ?? "application/json";
  const payload = await c.req.arrayBuffer();
  const metrics = createMetrics(c.env.METRICS);

  // Pass through producer headers from client (if present) for deduplication
  const producerId = c.req.header("Producer-Id");
  const producerEpoch = c.req.header("Producer-Epoch");
  const producerSeq = c.req.header("Producer-Seq");

  const headers: Record<string, string> = {
    "Content-Type": contentType,
  };

  // Include producer headers if client provided them for idempotency
  if (producerId && producerEpoch && producerSeq) {
    headers["Producer-Id"] = producerId;
    headers["Producer-Epoch"] = producerEpoch;
    headers["Producer-Seq"] = producerSeq;
  }

  // 1. Write to the source stream in core (uses service binding if available)
  const writeResponse = await fetchFromCore(c.env, `/v1/stream/${streamId}`, {
    method: "POST",
    headers,
    body: payload,
  });

  if (!writeResponse.ok) {
    const errorText = await writeResponse.text();
    // Record publish error metric
    metrics.publishError(streamId, `http_${writeResponse.status}`, Date.now() - start);
    return c.json(
      { error: "Failed to write to stream", details: errorText },
      writeResponse.status as 400 | 404 | 500,
    );
  }

  // Get the offset for fanout deduplication
  const sourceOffset = writeResponse.headers.get("X-Stream-Next-Offset");

  // Build producer headers for fanout deduplication
  let fanoutProducerHeaders: Record<string, string> | undefined;
  if (sourceOffset) {
    fanoutProducerHeaders = {
      "Producer-Id": `fanout:${streamId}`,
      "Producer-Epoch": "1",
      "Producer-Seq": sourceOffset,
    };
  }

  // 2. Fan out to all subscribed session streams
  const { fanoutCount, successCount, failureCount } = await fanOutToSubscribers(
    c.env,
    streamId,
    payload,
    contentType,
    fanoutProducerHeaders,
  );

  // Record publish metric
  const latencyMs = Date.now() - start;
  metrics.publish(streamId, fanoutCount, latencyMs);

  // Return the response from core with fanout info
  const responseHeaders = new Headers(writeResponse.headers);
  responseHeaders.set("X-Fanout-Count", fanoutCount.toString());
  responseHeaders.set("X-Fanout-Successes", successCount.toString());
  responseHeaders.set("X-Fanout-Failures", failureCount.toString());

  return new Response(writeResponse.body, {
    status: writeResponse.status,
    headers: responseHeaders,
  });
});
