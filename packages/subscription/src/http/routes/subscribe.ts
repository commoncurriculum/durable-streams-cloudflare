import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { subscribe } from "../../subscriptions/subscribe";
import { unsubscribe } from "../../subscriptions/unsubscribe";
import { deleteSession } from "../../session";
import { SESSION_ID_PATTERN, STREAM_ID_PATTERN } from "../../constants";
import type { SubscriptionDO } from "../../subscriptions/do";
import type { CoreClientEnv } from "../../client";

export interface SubscribeEnv {
  Bindings: CoreClientEnv & {
    SUBSCRIPTION_DO: DurableObjectNamespace<SubscriptionDO>;
    SESSION_TTL_SECONDS?: string;
    METRICS?: AnalyticsEngineDataset;
  };
}

const subscribeSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_PATTERN, "Invalid sessionId format"),
  streamId: z.string().min(1).regex(STREAM_ID_PATTERN, "Invalid streamId format"),
  contentType: z.string().optional().default("application/json"),
});

const unsubscribeSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_PATTERN, "Invalid sessionId format"),
  streamId: z.string().min(1).regex(STREAM_ID_PATTERN, "Invalid streamId format"),
});

export const subscribeRoutes = new Hono<SubscribeEnv>();

subscribeRoutes.post("/subscribe", zValidator("json", subscribeSchema), async (c) => {
  const { sessionId, streamId, contentType } = c.req.valid("json");
  try {
    return c.json(await subscribe(c.env, streamId, sessionId, contentType));
  } catch {
    return c.json({ error: "Failed to subscribe" }, 500);
  }
});

subscribeRoutes.delete("/unsubscribe", zValidator("json", unsubscribeSchema), async (c) => {
  const { sessionId, streamId } = c.req.valid("json");
  try {
    return c.json(await unsubscribe(c.env, streamId, sessionId));
  } catch {
    return c.json({ error: "Failed to remove subscription" }, 500);
  }
});

subscribeRoutes.delete("/session/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  try {
    return c.json(await deleteSession(c.env, sessionId));
  } catch {
    return c.json({ error: "Failed to delete session stream" }, 500);
  }
});
