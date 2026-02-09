import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { env } from "cloudflare:test";

const PROJECT_ID = "test-project";

function createTestApp() {
  return import("../../src/http/routes/session").then(({ sessionRoutes }) => {
    const app = new Hono();
    app.route(`/v1/:project`, sessionRoutes);
    return app;
  });
}

describe("GET /session/:sessionId", () => {
  it("returns 404 when session does not exist", async () => {
    const app = await createTestApp();
    const res = await app.request(`/v1/${PROJECT_ID}/session/00000000-0000-0000-0000-000000000000`, {}, env);

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Session not found");
  });

  it("returns 400 for invalid session ID format", async () => {
    const app = await createTestApp();
    const res = await app.request(`/v1/${PROJECT_ID}/session/not-a-uuid`, {}, env);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Invalid sessionId format");
  });

  it("returns session info when session exists", async () => {
    const sessionId = crypto.randomUUID();
    await env.CORE.putStream(`${PROJECT_ID}/${sessionId}`, { contentType: "application/json" });

    const app = await createTestApp();
    const res = await app.request(`/v1/${PROJECT_ID}/session/${sessionId}`, {}, env);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      sessionId: string;
      sessionStreamPath: string;
      subscriptions: Array<{ streamId: string }>;
    };
    expect(body.sessionId).toBe(sessionId);
    expect(body.sessionStreamPath).toBe(`/v1/${PROJECT_ID}/stream/${sessionId}`);
  });
});

describe("POST /session/:sessionId/touch", () => {
  it("creates a new session on touch", async () => {
    const sessionId = crypto.randomUUID();

    const app = await createTestApp();
    const res = await app.request(
      `/v1/${PROJECT_ID}/session/${sessionId}/touch`,
      { method: "POST" },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { sessionId: string; expiresAt: number };
    expect(body.sessionId).toBe(sessionId);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("succeeds when session already exists", async () => {
    const sessionId = crypto.randomUUID();
    await env.CORE.putStream(`${PROJECT_ID}/${sessionId}`, { contentType: "application/json" });

    const app = await createTestApp();
    const res = await app.request(
      `/v1/${PROJECT_ID}/session/${sessionId}/touch`,
      { method: "POST" },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { sessionId: string };
    expect(body.sessionId).toBe(sessionId);
  });
});
