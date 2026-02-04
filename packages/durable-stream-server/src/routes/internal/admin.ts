import { Hono } from "hono";
import type { DoBindings } from "../../hono/types";

export function createInternalAdminRoutes() {
  const app = new Hono<DoBindings>();

  app.get("/meta", async (c) => {
    const ctx = c.get("ctx");
    const streamId = c.get("streamId");

    const meta = await ctx.getStream(streamId);
    if (!meta) {
      return c.json({ error: "stream not found" }, 404);
    }

    return c.json({
      streamId,
      contentType: meta.content_type,
      closed: meta.closed,
      createdAt: meta.created_at,
      expiresAt: meta.expires_at,
      ttlSeconds: meta.ttl_seconds,
    });
  });

  app.get("/subscribers", async (c) => {
    const ctx = c.get("ctx");
    const streamId = c.get("streamId");

    const subscribers = await ctx.storage.listStreamSubscribers(streamId);
    return c.json({ subscribers });
  });

  return app;
}
