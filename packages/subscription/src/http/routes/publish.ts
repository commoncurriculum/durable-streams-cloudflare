import { Hono } from "hono";
import { arktypeValidator } from "@hono/arktype-validator";
import { type } from "arktype";
import { publish } from "../../subscriptions/publish";
import { createMetrics } from "../../metrics";
import { STREAM_ID_PATTERN } from "../../constants";
import type { AppEnv } from "../../env";

export const publishRoutes = new Hono<{ Bindings: AppEnv }>();

const streamIdParamSchema = type({
  streamId: type("string > 0").pipe((s, ctx) => {
    if (!STREAM_ID_PATTERN.test(s)) return ctx.error("Invalid streamId format");
    return s;
  }),
});

// #region synced-to-docs:publish-route
publishRoutes.post("/publish/:streamId", arktypeValidator("param", streamIdParamSchema), async (c) => {
  const start = Date.now();
  const projectId = c.req.param("project")!;
  const streamId = c.req.param("streamId");
  const metrics = createMetrics(c.env.METRICS);

  try {
    const result = await publish(c.env, projectId, streamId, {
      payload: await c.req.arrayBuffer(),
      contentType: c.req.header("Content-Type") ?? "application/json",
      producerId: c.req.header("Producer-Id") ?? undefined,
      producerEpoch: c.req.header("Producer-Epoch") ?? undefined,
      producerSeq: c.req.header("Producer-Seq") ?? undefined,
    });
    // #endregion synced-to-docs:publish-route

    if (result.status >= 400) {
      metrics.publishError(streamId, `http_${result.status}`, Date.now() - start);
    }

    const headers = new Headers({ "Content-Type": "application/json" });
    if (result.nextOffset) headers.set("X-Stream-Next-Offset", result.nextOffset);
    if (result.upToDate) headers.set("X-Stream-Up-To-Date", result.upToDate);
    if (result.streamClosed) headers.set("X-Stream-Closed", result.streamClosed);
    headers.set("X-Fanout-Count", result.fanoutCount.toString());
    headers.set("X-Fanout-Successes", result.fanoutSuccesses.toString());
    headers.set("X-Fanout-Failures", result.fanoutFailures.toString());
    headers.set("X-Fanout-Mode", result.fanoutMode);

    return new Response(result.body, { status: result.status, headers });
  } catch {
    metrics.publishError(streamId, "exception", Date.now() - start);
    return c.json({ error: "Failed to publish" }, 500);
  }
});
