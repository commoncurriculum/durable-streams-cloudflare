import { Hono } from "hono";
import type { EdgeBindings } from "../../hono/types";

export function createHealthRoutes() {
  const app = new Hono<EdgeBindings>();

  app.get("/", async (c) => {
    return c.json({
      status: "ok",
      timestamp: Date.now(),
    });
  });

  return app;
}
