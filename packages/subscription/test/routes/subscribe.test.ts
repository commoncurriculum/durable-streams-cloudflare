import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/env";

// Mock service functions
const mockSubscribe = vi.fn();
const mockUnsubscribe = vi.fn();
const mockDeleteSession = vi.fn();

vi.mock("../../src/subscriptions/subscribe", () => ({
  subscribe: (...args: unknown[]) => mockSubscribe(...args),
}));

vi.mock("../../src/subscriptions/unsubscribe", () => ({
  unsubscribe: (...args: unknown[]) => mockUnsubscribe(...args),
}));

vi.mock("../../src/session", () => ({
  deleteSession: (...args: unknown[]) => mockDeleteSession(...args),
}));

const PROJECT_ID = "test-project";
const SESSION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const SESSION_ID_2 = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

function createTestApp() {
  return import("../../src/http/routes/subscribe").then(({ subscribeRoutes }) => {
    const app = new Hono();
    app.route(`/v1/:project`, subscribeRoutes);
    return app;
  });
}

function createMockEnv() {
  return {
    CORE_URL: "http://localhost:8787",
    SUBSCRIPTION_DO: {} as AppEnv["SUBSCRIPTION_DO"],
    METRICS: {} as AnalyticsEngineDataset,
    SESSION_TTL_SECONDS: "1800",
  };
}

describe("POST /subscribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validation", () => {
    it("returns 400 when sessionId is missing", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        body: JSON.stringify({ streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(400);
    });

    it("returns 400 when streamId is missing", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        body: JSON.stringify({ sessionId: SESSION_ID }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(400);
    });

    it("returns 400 when sessionId contains invalid characters", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        body: JSON.stringify({ sessionId: "session;DROP TABLE", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(400);
    });

    it("returns 400 when streamId contains invalid characters", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        body: JSON.stringify({ sessionId: SESSION_ID, streamId: "stream'OR'1'='1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(400);
    });

    it("returns 400 when sessionId contains spaces", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        body: JSON.stringify({ sessionId: "session with spaces", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(400);
    });

    it("accepts valid sessionId (UUID format)", async () => {
      mockSubscribe.mockResolvedValue({
        sessionId: SESSION_ID,
        streamId: "stream-1",
        sessionStreamPath: `/v1/${PROJECT_ID}/stream/${SESSION_ID}`,
        expiresAt: Date.now() + 1800000,
        isNewSession: true,
      });

      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        body: JSON.stringify({ sessionId: SESSION_ID, streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(200);
    });
  });

  describe("subscription flow", () => {
    it("calls subscribe service with correct params", async () => {
      mockSubscribe.mockResolvedValue({
        sessionId: SESSION_ID,
        streamId: "stream-abc",
        sessionStreamPath: `/v1/${PROJECT_ID}/stream/${SESSION_ID}`,
        expiresAt: Date.now() + 1800000,
        isNewSession: true,
      });

      const app = await createTestApp();
      const env = createMockEnv();
      await app.request(`/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        body: JSON.stringify({ sessionId: SESSION_ID, streamId: "stream-abc" }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(mockSubscribe).toHaveBeenCalledWith(
        env,
        PROJECT_ID,
        "stream-abc",
        SESSION_ID,
        "application/json",
      );
    });

    it("returns 500 when subscribe service throws", async () => {
      mockSubscribe.mockRejectedValue(new Error("Failed to create session stream: 500"));

      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        body: JSON.stringify({ sessionId: SESSION_ID, streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Failed to subscribe");
    });
  });

  describe("response", () => {
    it("returns sessionId, streamId, and sessionStreamPath", async () => {
      mockSubscribe.mockResolvedValue({
        sessionId: SESSION_ID,
        streamId: "my-stream",
        sessionStreamPath: `/v1/${PROJECT_ID}/stream/${SESSION_ID}`,
        expiresAt: Date.now() + 1800000,
        isNewSession: true,
      });

      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/subscribe`, {
        method: "POST",
        body: JSON.stringify({ sessionId: SESSION_ID, streamId: "my-stream" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sessionId: string;
        streamId: string;
        sessionStreamPath: string;
        expiresAt: number;
        isNewSession: boolean;
      };
      expect(body.sessionId).toBe(SESSION_ID);
      expect(body.streamId).toBe("my-stream");
      expect(body.sessionStreamPath).toBe(`/v1/${PROJECT_ID}/stream/${SESSION_ID}`);
      expect(body.isNewSession).toBe(true);
      expect(typeof body.expiresAt).toBe("number");
    });
  });
});

describe("DELETE /unsubscribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validation", () => {
    it("returns 400 when sessionId contains invalid characters", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/unsubscribe`, {
        method: "DELETE",
        body: JSON.stringify({ sessionId: "session;DROP TABLE", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(400);
    });

    it("returns 400 when streamId contains invalid characters", async () => {
      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/unsubscribe`, {
        method: "DELETE",
        body: JSON.stringify({ sessionId: SESSION_ID, streamId: "stream'OR'1'='1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(400);
    });
  });

  it("calls unsubscribe service and returns result", async () => {
    mockUnsubscribe.mockResolvedValue({
      sessionId: SESSION_ID,
      streamId: "stream-1",
      unsubscribed: true,
    });

    const app = await createTestApp();
    const res = await app.request(`/v1/${PROJECT_ID}/unsubscribe`, {
      method: "DELETE",
      body: JSON.stringify({ sessionId: SESSION_ID, streamId: "stream-1" }),
      headers: { "Content-Type": "application/json" },
    }, createMockEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; streamId: string; unsubscribed: boolean };
    expect(body.sessionId).toBe(SESSION_ID);
    expect(body.streamId).toBe("stream-1");
    expect(body.unsubscribed).toBe(true);
  });

  it("returns 500 when unsubscribe service throws", async () => {
    mockUnsubscribe.mockRejectedValue(new Error("DO error"));

    const app = await createTestApp();
    const res = await app.request(`/v1/${PROJECT_ID}/unsubscribe`, {
      method: "DELETE",
      body: JSON.stringify({ sessionId: SESSION_ID, streamId: "stream-1" }),
      headers: { "Content-Type": "application/json" },
    }, createMockEnv());

    expect(res.status).toBe(500);
  });
});

describe("DELETE /session/:sessionId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls deleteSession service", async () => {
    mockDeleteSession.mockResolvedValue({ sessionId: SESSION_ID, deleted: true });

    const app = await createTestApp();
    const env = createMockEnv();
    await app.request(`/v1/${PROJECT_ID}/session/${SESSION_ID}`, {
      method: "DELETE",
    }, env);

    expect(mockDeleteSession).toHaveBeenCalledWith(env, PROJECT_ID, SESSION_ID);
  });

  it("returns 500 when deleteSession service throws", async () => {
    mockDeleteSession.mockRejectedValue(new Error("Failed to delete session"));

    const app = await createTestApp();
    const res = await app.request(`/v1/${PROJECT_ID}/session/${SESSION_ID}`, {
      method: "DELETE",
    }, createMockEnv());

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Failed to delete session stream");
  });

  it("returns confirmation response", async () => {
    mockDeleteSession.mockResolvedValue({ sessionId: SESSION_ID_2, deleted: true });

    const app = await createTestApp();
    const res = await app.request(`/v1/${PROJECT_ID}/session/${SESSION_ID_2}`, {
      method: "DELETE",
    }, createMockEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; deleted: boolean };
    expect(body.sessionId).toBe(SESSION_ID_2);
    expect(body.deleted).toBe(true);
  });
});
