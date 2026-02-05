import { Hono } from "hono";
import type { EdgeBindings } from "./types";
import { corsMiddleware } from "./middleware/cors";
import { bearerAuthMiddleware } from "./middleware/auth";

export function createEdgeApp() {
  const app = new Hono<EdgeBindings>();

  app.onError((err, c) => {
    console.error("Hono error:", err);
    return c.json({ error: err.message }, 500);
  });

  app.use("*", corsMiddleware);
  app.use("*", bearerAuthMiddleware);

  // Core package only handles streams - no admin/subscription routes
  app.all("*", (c) => {
    return c.json({ error: "not found" }, 404);
  });

  return app;
}

export type EdgeAppType = ReturnType<typeof createEdgeApp>;
