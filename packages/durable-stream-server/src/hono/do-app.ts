import { Hono } from "hono";
import type { DoBindings } from "./types";
import type { StreamContext } from "../http/context";
import { createDoContextMiddleware } from "./middleware/do-context";
import { createInternalSubscriptionRoutes } from "../routes/internal/subscriptions";
import { createInternalAdminRoutes } from "../routes/internal/admin";

export function createDoApp(ctx: StreamContext, streamId: string) {
  const app = new Hono<DoBindings>();

  app.use("*", createDoContextMiddleware(ctx, streamId));

  app.route("/internal", createInternalSubscriptionRoutes());
  app.route("/internal/admin", createInternalAdminRoutes());

  return app;
}

export type DoAppType = ReturnType<typeof createDoApp>;
