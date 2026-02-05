import { Hono } from "hono";
import type { DoBindings } from "./types";
import type { StreamContext } from "../http/context";
import { createDoContextMiddleware } from "./middleware/do-context";

export function createDoApp(ctx: StreamContext, streamId: string) {
  const app = new Hono<DoBindings>();

  app.use("*", createDoContextMiddleware(ctx, streamId));

  // Admin config endpoint - returns stream metadata for admin queries
  app.get("/internal/admin/config", async (c) => {
    const streamCtx = c.get("ctx");
    const id = c.get("streamId");

    const meta = await streamCtx.getStream(id);
    if (!meta) {
      return c.json({ error: "stream not found" }, 404);
    }

    return c.json({
      streamId: id,
      contentType: meta.content_type,
      closed: meta.closed === 1,
      tailOffset: meta.tail_offset,
      createdAt: meta.created_at,
      expiresAt: meta.expires_at,
    });
  });

  return app;
}

export type DoAppType = ReturnType<typeof createDoApp>;
