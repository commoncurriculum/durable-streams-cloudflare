import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { env } from "cloudflare:test";

const PROJECT_ID = "test-project";

function createTestApp() {
  return import("../../src/http/routes/subscribe").then(({ subscribeRoutes }) => {
    const app = new Hono();
    app.route("/v1/estuary", subscribeRoutes);
    return app;
  });
}

describe("POST /subscribe/:projectId/:streamId", () => {
  describe("validation", () => {
    it("returns 400 when estuaryId is missing", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/estuary/subscribe/${PROJECT_ID}/stream-1`, {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(res.status).toBe(400);
    });

    it("returns 400 when estuaryId contains invalid characters", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/estuary/subscribe/${PROJECT_ID}/stream-1`, {
        method: "POST",
        body: JSON.stringify({ estuaryId: "estuary;DROP TABLE" }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(res.status).toBe(400);
    });

    it("returns 400 when estuaryId contains spaces", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/estuary/subscribe/${PROJECT_ID}/stream-1`, {
        method: "POST",
        body: JSON.stringify({ estuaryId: "estuary with spaces" }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(res.status).toBe(400);
    });
  });

  describe("subscription flow", () => {
    it("creates estuary and subscribes successfully", async () => {
      const estuaryId = crypto.randomUUID();
      const streamId = `stream-${crypto.randomUUID()}`;

      // Create source stream so subscribe's headStream check succeeds
      await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

      const app = await createTestApp();
      const res = await app.request(`/v1/estuary/subscribe/${PROJECT_ID}/${streamId}`, {
        method: "POST",
        body: JSON.stringify({ estuaryId }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(res.status).toBe(200);
      const body = await res.json() as {
        estuaryId: string;
        streamId: string;
        estuaryStreamPath: string;
        isNewEstuary: boolean;
      };
      expect(body.estuaryId).toBe(estuaryId);
      expect(body.streamId).toBe(streamId);
      expect(body.estuaryStreamPath).toBe(`/v1/stream/${PROJECT_ID}/${estuaryId}`);
      expect(body.isNewEstuary).toBe(true);
    });

    it("returns isNewEstuary false for existing estuary", async () => {
      const estuaryId = crypto.randomUUID();
      const streamId = `stream-${crypto.randomUUID()}`;

      // Create source stream so subscribe's headStream check succeeds
      await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

      // Pre-create estuary stream
      await env.CORE.putStream(`${PROJECT_ID}/${estuaryId}`, { contentType: "application/json" });

      const app = await createTestApp();
      const res = await app.request(`/v1/estuary/subscribe/${PROJECT_ID}/${streamId}`, {
        method: "POST",
        body: JSON.stringify({ estuaryId }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(res.status).toBe(200);
      const body = await res.json() as { isNewEstuary: boolean };
      expect(body.isNewEstuary).toBe(false);
    });
  });
});

describe("DELETE /subscribe/:projectId/:streamId", () => {
  it("unsubscribes successfully", async () => {
    const estuaryId = crypto.randomUUID();
    const streamId = `stream-${crypto.randomUUID()}`;

    // Create source stream so subscribe's headStream check succeeds
    await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

    // Subscribe first
    const app = await createTestApp();
    await app.request(`/v1/estuary/subscribe/${PROJECT_ID}/${streamId}`, {
      method: "POST",
      body: JSON.stringify({ estuaryId }),
      headers: { "Content-Type": "application/json" },
    }, env);

    // Now unsubscribe
    const res = await app.request(`/v1/estuary/subscribe/${PROJECT_ID}/${streamId}`, {
      method: "DELETE",
      body: JSON.stringify({ estuaryId }),
      headers: { "Content-Type": "application/json" },
    }, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { estuaryId: string; streamId: string; unsubscribed: boolean };
    expect(body.estuaryId).toBe(estuaryId);
    expect(body.streamId).toBe(streamId);
    expect(body.unsubscribed).toBe(true);
  });

  describe("validation", () => {
    it("returns 400 when estuaryId contains invalid characters", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/estuary/subscribe/${PROJECT_ID}/stream-1`, {
        method: "DELETE",
        body: JSON.stringify({ estuaryId: "estuary;DROP TABLE" }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(res.status).toBe(400);
    });
  });
});
