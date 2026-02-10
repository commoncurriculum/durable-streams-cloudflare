import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { env } from "cloudflare:test";

const PROJECT_ID = "test-project";
const SESSION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function createTestApp() {
  return import("../../src/http/routes/subscribe").then(({ subscribeRoutes }) => {
    const app = new Hono();
    app.route(`/v1/:project`, subscribeRoutes);
    return app;
  });
}

describe("POST /subscribe", () => {
  describe("validation", () => {
    it("returns 400 when sessionId is missing", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        body: JSON.stringify({ streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(res.status).toBe(400);
    });

    it("returns 400 when streamId is missing", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        body: JSON.stringify({ sessionId: SESSION_ID }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(res.status).toBe(400);
    });

    it("returns 400 when sessionId contains invalid characters", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        body: JSON.stringify({ sessionId: "session;DROP TABLE", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(res.status).toBe(400);
    });

    it("returns 400 when streamId contains invalid characters", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        body: JSON.stringify({ sessionId: SESSION_ID, streamId: "stream'OR'1'='1" }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(res.status).toBe(400);
    });

    it("returns 400 when sessionId contains spaces", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        body: JSON.stringify({ sessionId: "session with spaces", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(res.status).toBe(400);
    });
  });

  describe("subscription flow", () => {
    it("creates session and subscribes successfully", async () => {
      const sessionId = crypto.randomUUID();
      const streamId = `stream-${crypto.randomUUID()}`;

      // Create source stream so subscribe's headStream check succeeds
      await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        body: JSON.stringify({ sessionId, streamId }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(res.status).toBe(200);
      const body = await res.json() as {
        sessionId: string;
        streamId: string;
        sessionStreamPath: string;
        isNewSession: boolean;
      };
      expect(body.sessionId).toBe(sessionId);
      expect(body.streamId).toBe(streamId);
      expect(body.sessionStreamPath).toBe(`/v1/stream/${PROJECT_ID}/${sessionId}`);
      expect(body.isNewSession).toBe(true);
    });

    it("returns isNewSession false for existing session", async () => {
      const sessionId = crypto.randomUUID();
      const streamId = `stream-${crypto.randomUUID()}`;

      // Create source stream so subscribe's headStream check succeeds
      await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

      // Pre-create session stream
      await env.CORE.putStream(`${PROJECT_ID}/${sessionId}`, { contentType: "application/json" });

      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        body: JSON.stringify({ sessionId, streamId }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(res.status).toBe(200);
      const body = await res.json() as { isNewSession: boolean };
      expect(body.isNewSession).toBe(false);
    });
  });
});

describe("DELETE /unsubscribe", () => {
  it("unsubscribes successfully", async () => {
    const sessionId = crypto.randomUUID();
    const streamId = `stream-${crypto.randomUUID()}`;

    // Create source stream so subscribe's headStream check succeeds
    await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

    // Subscribe first
    const app = await createTestApp();
    await app.request(`/v1/${PROJECT_ID}/subscribe`, {
      method: "POST",
      body: JSON.stringify({ sessionId, streamId }),
      headers: { "Content-Type": "application/json" },
    }, env);

    // Now unsubscribe
    const res = await app.request(`/v1/${PROJECT_ID}/unsubscribe`, {
      method: "DELETE",
      body: JSON.stringify({ sessionId, streamId }),
      headers: { "Content-Type": "application/json" },
    }, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { sessionId: string; streamId: string; unsubscribed: boolean };
    expect(body.sessionId).toBe(sessionId);
    expect(body.streamId).toBe(streamId);
    expect(body.unsubscribed).toBe(true);
  });

  describe("validation", () => {
    it("returns 400 when sessionId contains invalid characters", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/unsubscribe`, {
        method: "DELETE",
        body: JSON.stringify({ sessionId: "session;DROP TABLE", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(res.status).toBe(400);
    });

    it("returns 400 when streamId contains invalid characters", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/unsubscribe`, {
        method: "DELETE",
        body: JSON.stringify({ sessionId: SESSION_ID, streamId: "stream'OR'1'='1" }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(res.status).toBe(400);
    });
  });
});

describe("DELETE /session/:sessionId", () => {
  it("deletes an existing session", async () => {
    const sessionId = crypto.randomUUID();

    // Create session first
    await env.CORE.putStream(`${PROJECT_ID}/${sessionId}`, { contentType: "application/json" });

    const app = await createTestApp();
    const res = await app.request(`/v1/${PROJECT_ID}/session/${sessionId}`, {
      method: "DELETE",
    }, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { sessionId: string; deleted: boolean };
    expect(body.sessionId).toBe(sessionId);
    expect(body.deleted).toBe(true);
  });

  it("returns success for non-existent session (idempotent)", async () => {
    const sessionId = crypto.randomUUID();

    const app = await createTestApp();
    const res = await app.request(`/v1/${PROJECT_ID}/session/${sessionId}`, {
      method: "DELETE",
    }, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: boolean };
    expect(body.deleted).toBe(true);
  });
});
