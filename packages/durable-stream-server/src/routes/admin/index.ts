import { Hono } from "hono";
import type { EdgeBindings } from "../../hono/types";
import { createHealthRoutes } from "./health";
import { createAdminStreamsRoutes } from "./streams";
import { createAdminSessionsRoutes } from "./sessions";

export function createAdminRoutes() {
  const app = new Hono<EdgeBindings>();

  // API routes under /admin/api/*
  app.route("/api/health", createHealthRoutes());
  app.route("/api/streams", createAdminStreamsRoutes());
  app.route("/api/sessions", createAdminSessionsRoutes());

  // Legacy routes (for backwards compatibility) - also available at /admin/*
  app.route("/health", createHealthRoutes());
  app.route("/streams", createAdminStreamsRoutes());
  app.route("/sessions", createAdminSessionsRoutes());

  return app;
}
