import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { env } from "cloudflare:test";

const PROJECT_ID = "test-project";

function createTestApp() {
  return import("../../src/http/routes/publish").then(({ publishRoutes }) => {
    const app = new Hono();
    app.route(`/v1/:project`, publishRoutes);
    return app;
  });
}

describe("POST /publish/:streamId", () => {
  describe("streamId validation", () => {
    it("rejects invalid streamId with semicolon", async () => {
      const app = await createTestApp();
      const response = await app.request(`/v1/${PROJECT_ID}/publish/bad%3Bid`, {
        method: "POST",
        body: JSON.stringify({ data: "test" }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(response.status).toBe(400);
      const body = await response.json() as { success: boolean };
      expect(body.success).toBe(false);
    });

    it("rejects streamId with SQL-like content", async () => {
      const app = await createTestApp();
      const response = await app.request(`/v1/${PROJECT_ID}/publish/'; DROP TABLE --`, {
        method: "POST",
        body: JSON.stringify({ data: "test" }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(response.status).toBe(400);
    });

    it("rejects streamId with quotes", async () => {
      const app = await createTestApp();
      const response = await app.request(`/v1/${PROJECT_ID}/publish/test'id`, {
        method: "POST",
        body: JSON.stringify({ data: "test" }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(response.status).toBe(400);
    });

    it("accepts valid streamId formats", async () => {
      const app = await createTestApp();
      const validIds = ["stream-123", "my_stream", "user:stream:1", "Stream.Name.123"];
      for (const id of validIds) {
        // Create stream first so publish doesn't 404
        await env.CORE.putStream(`${PROJECT_ID}/${id}`, { contentType: "application/json" });

        const response = await app.request(`/v1/${PROJECT_ID}/publish/${encodeURIComponent(id)}`, {
          method: "POST",
          body: JSON.stringify({ data: "test" }),
          headers: { "Content-Type": "application/json" },
        }, env);
        expect(response.status).not.toBe(400);
      }
    });
  });

  describe("publish flow", () => {
    it("publishes to an existing stream and returns success", async () => {
      const streamId = `stream-${crypto.randomUUID()}`;
      await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/publish/${streamId}`, {
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      expect(res.headers.get("X-Fanout-Count")).toBe("0");
      expect(res.headers.get("X-Fanout-Mode")).toBe("inline");
    });

    it("returns 404 when stream does not exist", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/publish/nonexistent-stream`, {
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(res.status).toBe(404);
    });

    it("sets X-Stream-Next-Offset header on success", async () => {
      const streamId = `stream-${crypto.randomUUID()}`;
      await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/publish/${streamId}`, {
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.headers.get("X-Stream-Next-Offset")).not.toBeNull();
    });
  });

  describe("producer headers (idempotency)", () => {
    it("passes producer headers through to core", async () => {
      const streamId = `stream-${crypto.randomUUID()}`;
      await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "text/plain" });

      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/publish/${streamId}`, {
        method: "POST",
        body: "test",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": "producer-1",
          "Producer-Epoch": "1",
          "Producer-Seq": "0",
        },
      }, env);

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    });
  });
});
