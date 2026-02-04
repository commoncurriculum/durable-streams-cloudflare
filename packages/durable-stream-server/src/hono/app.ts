import { Hono } from "hono";
import type { EdgeBindings } from "./types";
import { corsMiddleware } from "./middleware/cors";
import { bearerAuthMiddleware } from "./middleware/auth";
import { createAdminRoutes } from "../routes/admin";
import { createSubscriptionRoutes } from "../routes/subscriptions";
import { createSessionRoutes } from "../routes/sessions";

export function createEdgeApp() {
  const app = new Hono<EdgeBindings>();

  app.onError((err, c) => {
    console.error("Hono error:", err);
    return c.json({ error: err.message }, 500);
  });

  app.use("*", corsMiddleware);
  app.use("*", bearerAuthMiddleware);

  app.route("/admin", createAdminRoutes());
  app.route("/v1/subscriptions", createSubscriptionRoutes());
  app.route("/v1/sessions", createSessionRoutes());

  return app;
}

export type EdgeAppType = ReturnType<typeof createEdgeApp>;
