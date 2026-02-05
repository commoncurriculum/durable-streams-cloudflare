import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock core-client
vi.mock("../../src/core-client", () => ({
  fetchFromCore: vi.fn(),
}));

// Mock analytics-queries
vi.mock("../../src/analytics-queries", () => ({
  getSessionSubscriptions: vi.fn(),
}));

// Mock metrics
vi.mock("../../src/metrics", () => ({
  createMetrics: vi.fn(() => ({
    sessionTouch: vi.fn(),
    reconcile: vi.fn(),
  })),
}));

function createTestApp() {
  return import("../../src/routes/session").then(({ sessionRoutes }) => {
    const app = new Hono();
    app.route("/v1", sessionRoutes);
    return app;
  });
}

function createMockEnv() {
  return {
    CORE_URL: "http://localhost:8787",
    SUBSCRIPTION_DO: {} as DurableObjectNamespace,
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

  it("returns 404 when session stream does not exist in core", async () => {
    const { fetchFromCore } = await import("../../src/core-client");

    vi.mocked(fetchFromCore).mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);

    const app = await createTestApp();
    const res = await app.request("/v1/session/nonexistent", {}, createMockEnv());

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Session not found");
  });

  it("checks session existence with HEAD request to core", async () => {
    const { fetchFromCore } = await import("../../src/core-client");
    const { getSessionSubscriptions } = await import("../../src/analytics-queries");

    vi.mocked(fetchFromCore).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
    vi.mocked(getSessionSubscriptions).mockResolvedValue({ data: [] });

    const app = await createTestApp();
    await app.request("/v1/session/session-123", {}, createMockEnv());

    expect(fetchFromCore).toHaveBeenCalledWith(
      expect.anything(),
      "/v1/stream/session:session-123",
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("returns session info when session exists", async () => {
    const { fetchFromCore } = await import("../../src/core-client");
    const { getSessionSubscriptions } = await import("../../src/analytics-queries");

    vi.mocked(fetchFromCore).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
    vi.mocked(getSessionSubscriptions).mockResolvedValue({ data: [] });

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

  it("includes subscriptions from Analytics Engine", async () => {
    const { fetchFromCore } = await import("../../src/core-client");
    const { getSessionSubscriptions } = await import("../../src/analytics-queries");

    vi.mocked(fetchFromCore).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
    vi.mocked(getSessionSubscriptions).mockResolvedValue({
      data: [
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

  it("queries Analytics Engine with correct parameters", async () => {
    const { fetchFromCore } = await import("../../src/core-client");
    const { getSessionSubscriptions } = await import("../../src/analytics-queries");

    vi.mocked(fetchFromCore).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
    vi.mocked(getSessionSubscriptions).mockResolvedValue({ data: [] });

    const app = await createTestApp();
    await app.request("/v1/session/my-session-id", {}, createMockEnv());

    expect(getSessionSubscriptions).toHaveBeenCalledWith(
      { ACCOUNT_ID: "test-account", API_TOKEN: "test-token" },
      "test_metrics",
      "my-session-id",
    );
  });

  it("continues without subscriptions if Analytics credentials not configured", async () => {
    const { fetchFromCore } = await import("../../src/core-client");
    const { getSessionSubscriptions } = await import("../../src/analytics-queries");

    vi.mocked(fetchFromCore).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const app = await createTestApp();
    const envWithoutAnalytics = {
      ...createMockEnv(),
      ACCOUNT_ID: undefined,
      API_TOKEN: undefined,
    };

    const res = await app.request("/v1/session/session-123", {}, envWithoutAnalytics);

    expect(res.status).toBe(200);
    expect(getSessionSubscriptions).not.toHaveBeenCalled();
    const body = (await res.json()) as { subscriptions: Array<{ streamId: string }> };
    expect(body.subscriptions).toEqual([]);
  });

  it("handles Analytics Engine query errors gracefully", async () => {
    const { fetchFromCore } = await import("../../src/core-client");
    const { getSessionSubscriptions } = await import("../../src/analytics-queries");

    vi.mocked(fetchFromCore).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
    // Return QueryResult with error instead of throwing
    vi.mocked(getSessionSubscriptions).mockResolvedValue({
      data: [],
      error: "Analytics error",
      errorType: "query",
    });

    const app = await createTestApp();
    const res = await app.request("/v1/session/session-123", {}, createMockEnv());

    // Should still return 200 with empty subscriptions
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subscriptions: Array<{ streamId: string }> };
    expect(body.subscriptions).toEqual([]);
  });
});

describe("POST /session/:sessionId/touch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("touches session by calling core with PUT request", async () => {
    const { fetchFromCore } = await import("../../src/core-client");

    vi.mocked(fetchFromCore).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const app = await createTestApp();
    await app.request(
      "/v1/session/session-123/touch",
      { method: "POST" },
      createMockEnv(),
    );

    expect(fetchFromCore).toHaveBeenCalledWith(
      expect.anything(),
      "/v1/stream/session:session-123",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "X-Stream-Expires-At": expect.any(String),
        }),
      }),
    );
  });

  it("returns 404 when session does not exist (non-409 error)", async () => {
    const { fetchFromCore } = await import("../../src/core-client");

    vi.mocked(fetchFromCore).mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);

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

  it("succeeds on 409 conflict (session exists)", async () => {
    const { fetchFromCore } = await import("../../src/core-client");

    // 409 means session already exists, which is acceptable for touch
    vi.mocked(fetchFromCore).mockResolvedValue({
      ok: false,
      status: 409,
    } as Response);

    const app = await createTestApp();
    const res = await app.request(
      "/v1/session/existing-session/touch",
      { method: "POST" },
      createMockEnv(),
    );

    expect(res.status).toBe(200);
  });

  it("records sessionTouch metric with latency", async () => {
    const { fetchFromCore } = await import("../../src/core-client");
    const { createMetrics } = await import("../../src/metrics");

    const mockMetrics = {
      sessionTouch: vi.fn(),
      reconcile: vi.fn(),
    };
    vi.mocked(createMetrics).mockReturnValue(mockMetrics as unknown as ReturnType<typeof createMetrics>);

    vi.mocked(fetchFromCore).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const app = await createTestApp();
    await app.request(
      "/v1/session/session-123/touch",
      { method: "POST" },
      createMockEnv(),
    );

    expect(mockMetrics.sessionTouch).toHaveBeenCalledWith(
      "session-123",
      expect.any(Number), // latency
    );
  });

  it("returns sessionId and expiresAt", async () => {
    const { fetchFromCore } = await import("../../src/core-client");

    vi.mocked(fetchFromCore).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const app = await createTestApp();
    const res = await app.request(
      "/v1/session/session-123/touch",
      { method: "POST" },
      createMockEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; expiresAt: number };
    expect(body.sessionId).toBe("session-123");
    expect(typeof body.expiresAt).toBe("number");
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("uses default TTL if SESSION_TTL_SECONDS not set", async () => {
    const { fetchFromCore } = await import("../../src/core-client");

    vi.mocked(fetchFromCore).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const app = await createTestApp();
    const envWithoutTtl = {
      ...createMockEnv(),
      SESSION_TTL_SECONDS: undefined,
    };

    const res = await app.request(
      "/v1/session/session-123/touch",
      { method: "POST" },
      envWithoutTtl,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { expiresAt: number };
    // Default TTL is 1800 seconds (30 minutes)
    const expectedMinExpiry = Date.now() + 1800 * 1000 - 5000; // 5 second tolerance
    expect(body.expiresAt).toBeGreaterThan(expectedMinExpiry);
  });
});

describe("GET /internal/reconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns message explaining new architecture", async () => {
    const app = await createTestApp();
    const res = await app.request("/v1/internal/reconcile", {}, createMockEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("handled automatically");
    expect(body.message).toContain("source of truth");
  });

  it("returns zero counts in new architecture", async () => {
    const app = await createTestApp();
    const res = await app.request("/v1/internal/reconcile", {}, createMockEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalSessions: number;
      validSessions: number;
      orphanedInD1: number;
      cleaned: number;
    };
    expect(body.totalSessions).toBe(0);
    expect(body.validSessions).toBe(0);
    expect(body.orphanedInD1).toBe(0);
    expect(body.cleaned).toBe(0);
  });

  it("records reconcile metric", async () => {
    const { createMetrics } = await import("../../src/metrics");

    const mockMetrics = {
      sessionTouch: vi.fn(),
      reconcile: vi.fn(),
    };
    vi.mocked(createMetrics).mockReturnValue(mockMetrics as unknown as ReturnType<typeof createMetrics>);

    const app = await createTestApp();
    await app.request("/v1/internal/reconcile", {}, createMockEnv());

    expect(mockMetrics.reconcile).toHaveBeenCalledWith(
      0, // total
      0, // valid
      0, // orphaned
      0, // cleaned
      0, // errors
      expect.any(Number), // latency
    );
  });
});
