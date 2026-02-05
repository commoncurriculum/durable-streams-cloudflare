import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

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

function createTestApp() {
  return import("../../src/http/routes/subscribe").then(({ subscribeRoutes }) => {
    const app = new Hono();
    app.route("/v1", subscribeRoutes);
    return app;
  });
}

function createMockEnv() {
  return {
    CORE_URL: "http://localhost:8787",
    SUBSCRIPTION_DO: {} as DurableObjectNamespace,
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
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(400);
    });

    it("returns 400 when streamId is missing", async () => {
      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(400);
    });

    it("returns 400 when sessionId contains invalid characters", async () => {
      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session;DROP TABLE", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(400);
    });

    it("returns 400 when streamId contains invalid characters", async () => {
      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1", streamId: "stream'OR'1'='1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(400);
    });

    it("returns 400 when sessionId contains spaces", async () => {
      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session with spaces", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(400);
    });

    it("accepts valid sessionId with allowed special characters", async () => {
      mockSubscribe.mockResolvedValue({
        sessionId: "user:123_test-session.v2",
        streamId: "stream-1",
        sessionStreamPath: "/v1/stream/session:user:123_test-session.v2",
        expiresAt: Date.now() + 1800000,
        isNewSession: true,
      });

      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "user:123_test-session.v2", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(200);
    });
  });

  describe("subscription flow", () => {
    it("calls subscribe service with correct params", async () => {
      mockSubscribe.mockResolvedValue({
        sessionId: "session-123",
        streamId: "stream-abc",
        sessionStreamPath: "/v1/stream/session:session-123",
        expiresAt: Date.now() + 1800000,
        isNewSession: true,
      });

      const app = await createTestApp();
      const env = createMockEnv();
      await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-123", streamId: "stream-abc" }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(mockSubscribe).toHaveBeenCalledWith(
        env,
        "stream-abc",
        "session-123",
        "application/json",
      );
    });

    it("returns 500 when subscribe service throws", async () => {
      mockSubscribe.mockRejectedValue(new Error("Failed to create session stream: 500"));

      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
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
        sessionId: "my-session-id",
        streamId: "my-stream",
        sessionStreamPath: "/v1/stream/session:my-session-id",
        expiresAt: Date.now() + 1800000,
        isNewSession: true,
      });

      const app = await createTestApp();
      const res = await app.request("/v1/subscribe", {
        method: "POST",
        body: JSON.stringify({ sessionId: "my-session-id", streamId: "my-stream" }),
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
      expect(body.sessionId).toBe("my-session-id");
      expect(body.streamId).toBe("my-stream");
      expect(body.sessionStreamPath).toBe("/v1/stream/session:my-session-id");
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
      const res = await app.request("/v1/unsubscribe", {
        method: "DELETE",
        body: JSON.stringify({ sessionId: "session;DROP TABLE", streamId: "stream-1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(400);
    });

    it("returns 400 when streamId contains invalid characters", async () => {
      const app = await createTestApp();
      const res = await app.request("/v1/unsubscribe", {
        method: "DELETE",
        body: JSON.stringify({ sessionId: "session-1", streamId: "stream'OR'1'='1" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(res.status).toBe(400);
    });
  });

  it("calls unsubscribe service and returns result", async () => {
    mockUnsubscribe.mockResolvedValue({
      sessionId: "session-1",
      streamId: "stream-1",
      unsubscribed: true,
    });

    const app = await createTestApp();
    const res = await app.request("/v1/unsubscribe", {
      method: "DELETE",
      body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
      headers: { "Content-Type": "application/json" },
    }, createMockEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; streamId: string; unsubscribed: boolean };
    expect(body.sessionId).toBe("session-1");
    expect(body.streamId).toBe("stream-1");
    expect(body.unsubscribed).toBe(true);
  });

  it("returns 500 when unsubscribe service throws", async () => {
    mockUnsubscribe.mockRejectedValue(new Error("DO error"));

    const app = await createTestApp();
    const res = await app.request("/v1/unsubscribe", {
      method: "DELETE",
      body: JSON.stringify({ sessionId: "session-1", streamId: "stream-1" }),
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
    mockDeleteSession.mockResolvedValue({ sessionId: "session-123", deleted: true });

    const app = await createTestApp();
    const env = createMockEnv();
    await app.request("/v1/session/session-123", {
      method: "DELETE",
    }, env);

    expect(mockDeleteSession).toHaveBeenCalledWith(env, "session-123");
  });

  it("returns 500 when deleteSession service throws", async () => {
    mockDeleteSession.mockRejectedValue(new Error("Failed to delete session"));

    const app = await createTestApp();
    const res = await app.request("/v1/session/session-123", {
      method: "DELETE",
    }, createMockEnv());

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("Failed to delete session stream");
  });

  it("returns confirmation response", async () => {
    mockDeleteSession.mockResolvedValue({ sessionId: "my-session", deleted: true });

    const app = await createTestApp();
    const res = await app.request("/v1/session/my-session", {
      method: "DELETE",
    }, createMockEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; deleted: boolean };
    expect(body.sessionId).toBe("my-session");
    expect(body.deleted).toBe(true);
  });
});
