import { Hono } from "hono";

export interface HealthEnv {
  Bindings: {
    ADMIN_DB: D1Database;
    CORE_URL: string;
    AUTH_TOKEN?: string;
  };
}

interface HealthStatus {
  status: "ok" | "degraded" | "down";
  checks: {
    d1: { status: "ok" | "down"; latencyMs?: number; error?: string };
    core: { status: "ok" | "down"; latencyMs?: number; error?: string };
  };
}

export const healthRoutes = new Hono<HealthEnv>();

// GET /health - Health check endpoint
healthRoutes.get("/health", async (c) => {
  const checks: HealthStatus["checks"] = {
    d1: { status: "down" },
    core: { status: "down" },
  };

  // Check D1
  const d1Start = Date.now();
  try {
    await c.env.ADMIN_DB.prepare("SELECT 1").first();
    checks.d1 = { status: "ok", latencyMs: Date.now() - d1Start };
  } catch (err) {
    checks.d1 = {
      status: "down",
      latencyMs: Date.now() - d1Start,
      error: String(err),
    };
  }

  // Check Core
  const coreStart = Date.now();
  try {
    const authHeaders: Record<string, string> = c.env.AUTH_TOKEN
      ? { Authorization: `Bearer ${c.env.AUTH_TOKEN}` }
      : {};

    const response = await fetch(`${c.env.CORE_URL}/v1/stream/__health__`, {
      method: "HEAD",
      headers: authHeaders,
    });

    // 404 is expected for non-existent stream, but shows core is responding
    if (response.status === 404 || response.ok) {
      checks.core = { status: "ok", latencyMs: Date.now() - coreStart };
    } else {
      checks.core = {
        status: "down",
        latencyMs: Date.now() - coreStart,
        error: `Unexpected status: ${response.status}`,
      };
    }
  } catch (err) {
    checks.core = {
      status: "down",
      latencyMs: Date.now() - coreStart,
      error: String(err),
    };
  }

  const allOk = checks.d1.status === "ok" && checks.core.status === "ok";
  const allDown = checks.d1.status === "down" && checks.core.status === "down";

  const healthStatus: HealthStatus = {
    status: allOk ? "ok" : allDown ? "down" : "degraded",
    checks,
  };

  const statusCode = healthStatus.status === "ok" ? 200 : 503;
  return c.json(healthStatus, statusCode);
});
