import { Hono } from "hono";
import type { EdgeBindings } from "../../hono/types";
import { createHealthRoutes } from "./health";
import { createAdminStreamsRoutes } from "./streams";
import { createAdminSessionsRoutes } from "./sessions";
import { createAdminMetricsRoutes } from "./metrics";

export function createAdminRoutes() {
  const app = new Hono<EdgeBindings>();

  // Admin API routes - mounted at /api/*
  app.route("/health", createHealthRoutes());
  app.route("/streams", createAdminStreamsRoutes());
  app.route("/sessions", createAdminSessionsRoutes());
  app.route("/metrics", createAdminMetricsRoutes());

  return app;
}
