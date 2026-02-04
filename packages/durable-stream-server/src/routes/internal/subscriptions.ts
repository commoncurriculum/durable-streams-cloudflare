import { Hono } from "hono";
import type { DoBindings } from "../../hono/types";
import {
  handleInternalSubscriptions,
  handleInternalSessionInit,
  handleInternalSubscribers,
  handleInternalFanInAppend,
} from "../../http/handlers/subscriptions";

export function createInternalSubscriptionRoutes() {
  const app = new Hono<DoBindings>();

  app.all("/subscriptions", async (c) => {
    const ctx = c.get("ctx");
    const streamId = c.get("streamId");
    return await handleInternalSubscriptions(ctx, streamId, c.req.raw);
  });

  app.all("/session", async (c) => {
    const ctx = c.get("ctx");
    const streamId = c.get("streamId");
    return await handleInternalSessionInit(ctx, streamId, c.req.raw);
  });

  app.all("/subscribers", async (c) => {
    const ctx = c.get("ctx");
    const streamId = c.get("streamId");
    return await handleInternalSubscribers(ctx, streamId, c.req.raw);
  });

  app.all("/fan-in-append", async (c) => {
    const ctx = c.get("ctx");
    const streamId = c.get("streamId");
    return await handleInternalFanInAppend(ctx, streamId, c.req.raw);
  });

  return app;
}
