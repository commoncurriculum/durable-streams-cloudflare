import { Hono } from "hono";
import type { EdgeBindings } from "../../hono/types";
import type { ServiceStatus } from "../../schemas/admin";

export function createHealthRoutes() {
  const app = new Hono<EdgeBindings>();

  app.get("/", async (c) => {
    const services: {
      registry?: ServiceStatus;
      d1?: ServiceStatus;
      r2?: ServiceStatus;
    } = {};

    // Check D1 availability
    const db = c.env.ADMIN_DB;
    if (db) {
      const start = Date.now();
      try {
        await db.prepare("SELECT 1").first();
        services.d1 = {
          available: true,
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        services.d1 = {
          available: false,
          latencyMs: Date.now() - start,
          error: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    // Check R2 availability
    const r2 = c.env.R2;
    if (r2) {
      const start = Date.now();
      try {
        // Try to list with limit 1 to check R2 connectivity
        await r2.list({ limit: 1 });
        services.r2 = {
          available: true,
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        services.r2 = {
          available: false,
          latencyMs: Date.now() - start,
          error: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    // Check registry DO availability
    const streams = c.env.STREAMS;
    if (streams) {
      const start = Date.now();
      try {
        const id = streams.idFromName("__registry__");
        const stub = streams.get(id);
        const response = await stub.fetch(
          new Request("http://internal/internal/admin/meta", { method: "GET" })
        );
        services.registry = {
          available: response.ok,
          latencyMs: Date.now() - start,
          error: response.ok ? undefined : `HTTP ${response.status}`,
        };
      } catch (err) {
        services.registry = {
          available: false,
          latencyMs: Date.now() - start,
          error: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    // Determine overall status
    const serviceStatuses = Object.values(services);
    const allAvailable = serviceStatuses.every((s) => s.available);
    const anyAvailable = serviceStatuses.some((s) => s.available);

    let status: "healthy" | "degraded" | "unhealthy";
    if (allAvailable && serviceStatuses.length > 0) {
      status = "healthy";
    } else if (anyAvailable) {
      status = "degraded";
    } else if (serviceStatuses.length === 0) {
      // No services configured, consider healthy
      status = "healthy";
    } else {
      status = "unhealthy";
    }

    return c.json({
      status,
      timestamp: Date.now(),
      services: Object.keys(services).length > 0 ? services : undefined,
    });
  });

  return app;
}
