import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { env } from "cloudflare:test";

const PROJECT_ID = "test-project";

function createTestApp() {
  return import("../../src/http/routes/estuary").then(({ estuaryRoutes }) => {
    const app = new Hono();
    app.route(`/v1/estuary`, estuaryRoutes);
    return app;
  });
}

describe("GET /:projectId/:estuaryId", () => {
  it("returns 404 when estuary does not exist", async () => {
    const app = await createTestApp();
    const res = await app.request(`/v1/estuary/${PROJECT_ID}/00000000-0000-0000-0000-000000000000`, {}, env);

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Estuary not found");
  });

  it("returns 400 for invalid estuaryId format", async () => {
    const app = await createTestApp();
    const res = await app.request(`/v1/estuary/${PROJECT_ID}/not-a-uuid`, {}, env);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Invalid estuaryId format");
  });

  it("returns estuary info when estuary exists", async () => {
    const estuaryId = crypto.randomUUID();
    await env.CORE.putStream(`${PROJECT_ID}/${estuaryId}`, { contentType: "application/json" });

    const app = await createTestApp();
    const res = await app.request(`/v1/estuary/${PROJECT_ID}/${estuaryId}`, {}, env);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      estuaryId: string;
      estuaryStreamPath: string;
      subscriptions: Array<{ streamId: string }>;
    };
    expect(body.estuaryId).toBe(estuaryId);
    expect(body.estuaryStreamPath).toBe(`/v1/stream/${PROJECT_ID}/${estuaryId}`);
  });
});

describe("POST /:projectId/:estuaryId", () => {
  it("creates a new estuary on touch", async () => {
    const estuaryId = crypto.randomUUID();

    const app = await createTestApp();
    const res = await app.request(
      `/v1/estuary/${PROJECT_ID}/${estuaryId}`,
      { method: "POST" },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { estuaryId: string; expiresAt: number };
    expect(body.estuaryId).toBe(estuaryId);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("succeeds when estuary already exists", async () => {
    const estuaryId = crypto.randomUUID();
    await env.CORE.putStream(`${PROJECT_ID}/${estuaryId}`, { contentType: "application/json" });

    const app = await createTestApp();
    const res = await app.request(
      `/v1/estuary/${PROJECT_ID}/${estuaryId}`,
      { method: "POST" },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { estuaryId: string };
    expect(body.estuaryId).toBe(estuaryId);
  });
});
