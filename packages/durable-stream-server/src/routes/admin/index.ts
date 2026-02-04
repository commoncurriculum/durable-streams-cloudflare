import { Hono } from "hono";
import type { EdgeBindings } from "../../hono/types";
import { createHealthRoutes } from "./health";
import { createAdminStreamsRoutes } from "./streams";
import { createAdminSessionsRoutes } from "./sessions";

export function createAdminRoutes() {
  const app = new Hono<EdgeBindings>();

  app.route("/health", createHealthRoutes());
  app.route("/streams", createAdminStreamsRoutes());
  app.route("/sessions", createAdminSessionsRoutes());

  return app;
}
