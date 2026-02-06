import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../../src/env";

// Mock session service functions
const mockGetSession = vi.fn();
const mockTouchSession = vi.fn();

vi.mock("../../src/session", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  touchSession: (...args: unknown[]) => mockTouchSession(...args),
}));

function createTestApp() {
  return import("../../src/http/routes/session").then(({ sessionRoutes }) => {
    const app = new Hono();
    app.route("/v1", sessionRoutes);
    return app;
  });
}

function createMockEnv() {
  return {
    CORE_URL: "http://localhost:8787",
    SUBSCRIPTION_DO: {} as AppEnv["SUBSCRIPTION_DO"],
    METRICS: {} as AnalyticsEngineDataset,
    ACCOUNT_ID: "test-account",
    API_TOKEN: "test-token",
    ANALYTICS_DATASET: "test_metrics",
    SESSION_TTL_SECONDS: "1800",
  };
}

describe("GET /session/:sessionId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when session does not exist", async () => {
    mockGetSession.mockResolvedValue(null);

    const app = await createTestApp();
    const res = await app.request("/v1/session/nonexistent", {}, createMockEnv());

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Session not found");
  });

  it("calls getSession service with correct params", async () => {
    mockGetSession.mockResolvedValue({
      sessionId: "session-123",
      sessionStreamPath: "/v1/stream/session:session-123",
      subscriptions: [],
    });

    const app = await createTestApp();
    const env = createMockEnv();
    await app.request("/v1/session/session-123", {}, env);

    expect(mockGetSession).toHaveBeenCalledWith(env, "session-123");
  });

  it("returns session info when session exists", async () => {
    mockGetSession.mockResolvedValue({
      sessionId: "session-123",
      sessionStreamPath: "/v1/stream/session:session-123",
      subscriptions: [],
    });

    const app = await createTestApp();
    const res = await app.request("/v1/session/session-123", {}, createMockEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      sessionStreamPath: string;
      subscriptions: Array<{ streamId: string }>;
    };
    expect(body.sessionId).toBe("session-123");
    expect(body.sessionStreamPath).toBe("/v1/stream/session:session-123");
  });

  it("includes subscriptions from service", async () => {
    mockGetSession.mockResolvedValue({
      sessionId: "session-123",
      sessionStreamPath: "/v1/stream/session:session-123",
      subscriptions: [
        { streamId: "stream-a" },
        { streamId: "stream-b" },
      ],
    });

    const app = await createTestApp();
    const res = await app.request("/v1/session/session-123", {}, createMockEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { subscriptions: Array<{ streamId: string }> };
    expect(body.subscriptions).toHaveLength(2);
    expect(body.subscriptions[0].streamId).toBe("stream-a");
    expect(body.subscriptions[1].streamId).toBe("stream-b");
  });
});

describe("POST /session/:sessionId/touch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls touchSession service with correct params", async () => {
    mockTouchSession.mockResolvedValue({
      sessionId: "session-123",
      expiresAt: Date.now() + 1800000,
    });

    const app = await createTestApp();
    const env = createMockEnv();
    await app.request(
      "/v1/session/session-123/touch",
      { method: "POST" },
      env,
    );

    expect(mockTouchSession).toHaveBeenCalledWith(env, "session-123");
  });

  it("returns 404 when touchSession throws", async () => {
    mockTouchSession.mockRejectedValue(new Error("Session not found: nonexistent"));

    const app = await createTestApp();
    const res = await app.request(
      "/v1/session/nonexistent/touch",
      { method: "POST" },
      createMockEnv(),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Session not found");
  });

  it("returns sessionId and expiresAt on success", async () => {
    const expiresAt = Date.now() + 1800000;
    mockTouchSession.mockResolvedValue({
      sessionId: "session-123",
      expiresAt,
    });

    const app = await createTestApp();
    const res = await app.request(
      "/v1/session/session-123/touch",
      { method: "POST" },
      createMockEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; expiresAt: number };
    expect(body.sessionId).toBe("session-123");
    expect(body.expiresAt).toBe(expiresAt);
  });
});

