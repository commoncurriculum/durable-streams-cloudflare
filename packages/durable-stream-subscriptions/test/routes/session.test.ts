import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock storage
vi.mock("../../src/storage", () => ({
  getSession: vi.fn(),
  getSessionSubscriptions: vi.fn(),
  touchSession: vi.fn(),
  getAllSessions: vi.fn(),
  deleteSession: vi.fn(),
}));

// Mock metrics
vi.mock("../../src/metrics", () => ({
  createMetrics: vi.fn(() => ({
    sessionTouch: vi.fn(),
    reconcile: vi.fn(),
  })),
}));

// Mock core-client
vi.mock("../../src/core-client", () => ({
  fetchFromCore: vi.fn(),
}));

function createTestApp() {
  // We need to dynamically import to pick up mocks
  return import("../../src/routes/session").then(({ sessionRoutes }) => {
    const app = new Hono();
    app.route("/v1", sessionRoutes);
    return app;
  });
}

function createMockEnv() {
  return {
    DB: {} as D1Database,
    CORE_URL: "http://localhost:8787",
    METRICS: {} as AnalyticsEngineDataset,
  };
}

describe("GET /session/:sessionId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when session does not exist", async () => {
    const { getSession } = await import("../../src/storage");
    vi.mocked(getSession).mockResolvedValue(null);

    const app = await createTestApp();
    const res = await app.request("/v1/session/nonexistent", {}, createMockEnv());

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Session not found");
  });

  it("returns session info with correct fields", async () => {
    const { getSession, getSessionSubscriptions } = await import("../../src/storage");
    const mockSession = {
      session_id: "session-123",
      created_at: 1000000,
      last_active_at: 2000000,
      ttl_seconds: 1800,
      marked_for_deletion_at: null,
    };
    vi.mocked(getSession).mockResolvedValue(mockSession);
    vi.mocked(getSessionSubscriptions).mockResolvedValue([]);

    const app = await createTestApp();
    const res = await app.request("/v1/session/session-123", {}, createMockEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; createdAt: number; lastActiveAt: number; ttlSeconds: number };
    expect(body.sessionId).toBe("session-123");
    expect(body.createdAt).toBe(1000000);
    expect(body.lastActiveAt).toBe(2000000);
    expect(body.ttlSeconds).toBe(1800);
  });

  it("includes all subscriptions in response", async () => {
    const { getSession, getSessionSubscriptions } = await import("../../src/storage");
    const mockSession = {
      session_id: "session-123",
      created_at: 1000000,
      last_active_at: 2000000,
      ttl_seconds: 1800,
      marked_for_deletion_at: null,
    };
    const mockSubs = [
      { session_id: "session-123", stream_id: "stream-a", subscribed_at: 1500000 },
      { session_id: "session-123", stream_id: "stream-b", subscribed_at: 1600000 },
    ];
    vi.mocked(getSession).mockResolvedValue(mockSession);
    vi.mocked(getSessionSubscriptions).mockResolvedValue(mockSubs);

    const app = await createTestApp();
    const res = await app.request("/v1/session/session-123", {}, createMockEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { subscriptions: Array<{ streamId: string; subscribedAt: number }> };
    expect(body.subscriptions).toHaveLength(2);
    expect(body.subscriptions[0].streamId).toBe("stream-a");
    expect(body.subscriptions[0].subscribedAt).toBe(1500000);
    expect(body.subscriptions[1].streamId).toBe("stream-b");
  });

  it("calculates expiresAt correctly from last_active_at + ttl", async () => {
    const { getSession, getSessionSubscriptions } = await import("../../src/storage");
    const mockSession = {
      session_id: "session-123",
      created_at: 1000000,
      last_active_at: 2000000,
      ttl_seconds: 1800, // 30 minutes
      marked_for_deletion_at: null,
    };
    vi.mocked(getSession).mockResolvedValue(mockSession);
    vi.mocked(getSessionSubscriptions).mockResolvedValue([]);

    const app = await createTestApp();
    const res = await app.request("/v1/session/session-123", {}, createMockEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { expiresAt: number };
    // expiresAt = last_active_at + (ttl_seconds * 1000)
    expect(body.expiresAt).toBe(2000000 + 1800 * 1000);
  });

  it("returns correct sessionStreamPath format", async () => {
    const { getSession, getSessionSubscriptions } = await import("../../src/storage");
    const mockSession = {
      session_id: "my-session-id",
      created_at: 1000000,
      last_active_at: 2000000,
      ttl_seconds: 1800,
      marked_for_deletion_at: null,
    };
    vi.mocked(getSession).mockResolvedValue(mockSession);
    vi.mocked(getSessionSubscriptions).mockResolvedValue([]);

    const app = await createTestApp();
    const res = await app.request("/v1/session/my-session-id", {}, createMockEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionStreamPath: string };
    expect(body.sessionStreamPath).toBe("/v1/stream/session:my-session-id");
  });
});

describe("POST /session/:sessionId/touch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when session does not exist", async () => {
    const { touchSession } = await import("../../src/storage");
    vi.mocked(touchSession).mockResolvedValue(false);

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

  it("updates last_active_at timestamp", async () => {
    const { touchSession, getSession } = await import("../../src/storage");
    const newLastActive = Date.now();
    vi.mocked(touchSession).mockResolvedValue(true);
    vi.mocked(getSession).mockResolvedValue({
      session_id: "session-123",
      created_at: 1000000,
      last_active_at: newLastActive,
      ttl_seconds: 1800,
      marked_for_deletion_at: null,
    });

    const app = await createTestApp();
    const res = await app.request(
      "/v1/session/session-123/touch",
      { method: "POST" },
      createMockEnv(),
    );

    expect(res.status).toBe(200);
    expect(touchSession).toHaveBeenCalledWith(expect.anything(), "session-123");
  });

  it("records sessionTouch metric with latency", async () => {
    const { touchSession, getSession } = await import("../../src/storage");
    const { createMetrics } = await import("../../src/metrics");

    const mockMetrics = {
      sessionTouch: vi.fn(),
      reconcile: vi.fn(),
    };
    vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

    vi.mocked(touchSession).mockResolvedValue(true);
    vi.mocked(getSession).mockResolvedValue({
      session_id: "session-123",
      created_at: 1000000,
      last_active_at: 2000000,
      ttl_seconds: 1800,
      marked_for_deletion_at: null,
    });

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

  it("returns updated session info", async () => {
    const { touchSession, getSession } = await import("../../src/storage");
    vi.mocked(touchSession).mockResolvedValue(true);
    vi.mocked(getSession).mockResolvedValue({
      session_id: "session-123",
      created_at: 1000000,
      last_active_at: 3000000,
      ttl_seconds: 1800,
      marked_for_deletion_at: null,
    });

    const app = await createTestApp();
    const res = await app.request(
      "/v1/session/session-123/touch",
      { method: "POST" },
      createMockEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; lastActiveAt: number; expiresAt: number };
    expect(body.sessionId).toBe("session-123");
    expect(body.lastActiveAt).toBe(3000000);
    expect(body.expiresAt).toBe(3000000 + 1800 * 1000);
  });

  it("clears marked_for_deletion_at flag if set", async () => {
    const { touchSession } = await import("../../src/storage");

    // touchSession internally clears the marked_for_deletion_at flag
    // We verify it's called; the storage module test verifies it clears the flag
    vi.mocked(touchSession).mockResolvedValue(true);

    const app = await createTestApp();
    await app.request(
      "/v1/session/marked-session/touch",
      { method: "POST" },
      createMockEnv(),
    );

    expect(touchSession).toHaveBeenCalledWith(expect.anything(), "marked-session");
  });
});

describe("GET /internal/reconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("core functionality", () => {
    it("returns count of valid sessions (core returns 200)", async () => {
      const { getAllSessions } = await import("../../src/storage");
      const { fetchFromCore } = await import("../../src/core-client");

      vi.mocked(getAllSessions).mockResolvedValue([
        { session_id: "valid-1", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
        { session_id: "valid-2", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
      ]);

      vi.mocked(fetchFromCore).mockResolvedValue({ ok: true, status: 200 } as Response);

      const app = await createTestApp();
      const res = await app.request("/v1/internal/reconcile", {}, createMockEnv());

      expect(res.status).toBe(200);
      const body = (await res.json()) as { validSessions: number; orphanedInD1: number };
      expect(body.validSessions).toBe(2);
      expect(body.orphanedInD1).toBe(0);
    });

    it("returns count of orphaned sessions (core returns 404)", async () => {
      const { getAllSessions } = await import("../../src/storage");
      const { fetchFromCore } = await import("../../src/core-client");

      vi.mocked(getAllSessions).mockResolvedValue([
        { session_id: "orphan-1", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
      ]);

      vi.mocked(fetchFromCore).mockResolvedValue({ ok: false, status: 404 } as Response);

      const app = await createTestApp();
      const res = await app.request("/v1/internal/reconcile", {}, createMockEnv());

      expect(res.status).toBe(200);
      const body = (await res.json()) as { validSessions: number; orphanedInD1: number; orphanedSessionIds: string[] };
      expect(body.validSessions).toBe(0);
      expect(body.orphanedInD1).toBe(1);
      expect(body.orphanedSessionIds).toContain("orphan-1");
    });

    it("handles core returning error status (not 200 or 404)", async () => {
      const { getAllSessions } = await import("../../src/storage");
      const { fetchFromCore } = await import("../../src/core-client");

      vi.mocked(getAllSessions).mockResolvedValue([
        { session_id: "error-session", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
      ]);

      vi.mocked(fetchFromCore).mockResolvedValue({ ok: false, status: 500 } as Response);

      const app = await createTestApp();
      const res = await app.request("/v1/internal/reconcile", {}, createMockEnv());

      expect(res.status).toBe(200);
      const body = (await res.json()) as { validSessions: number; orphanedInD1: number; errors: string[] };
      expect(body.validSessions).toBe(0);
      expect(body.orphanedInD1).toBe(0);
      expect(body.errors).toBeDefined();
      expect(body.errors[0]).toContain("error-session");
      expect(body.errors[0]).toContain("500");
    });

    it("handles fetch exceptions during core check", async () => {
      const { getAllSessions } = await import("../../src/storage");
      const { fetchFromCore } = await import("../../src/core-client");

      vi.mocked(getAllSessions).mockResolvedValue([
        { session_id: "fetch-fail", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
      ]);

      vi.mocked(fetchFromCore).mockRejectedValue(new Error("Network error"));

      const app = await createTestApp();
      const res = await app.request("/v1/internal/reconcile", {}, createMockEnv());

      expect(res.status).toBe(200);
      const body = (await res.json()) as { errors: string[] };
      expect(body.errors).toBeDefined();
      expect(body.errors[0]).toContain("fetch-fail");
    });
  });

  describe("cleanup behavior", () => {
    it("does not clean up when cleanup param not specified", async () => {
      const { getAllSessions, deleteSession } = await import("../../src/storage");
      const { fetchFromCore } = await import("../../src/core-client");

      vi.mocked(getAllSessions).mockResolvedValue([
        { session_id: "orphan-1", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
      ]);
      vi.mocked(fetchFromCore).mockResolvedValue({ ok: false, status: 404 } as Response);

      const app = await createTestApp();
      await app.request("/v1/internal/reconcile", {}, createMockEnv());

      expect(deleteSession).not.toHaveBeenCalled();
    });

    it("does not clean up when cleanup=false", async () => {
      const { getAllSessions, deleteSession } = await import("../../src/storage");
      const { fetchFromCore } = await import("../../src/core-client");

      vi.mocked(getAllSessions).mockResolvedValue([
        { session_id: "orphan-1", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
      ]);
      vi.mocked(fetchFromCore).mockResolvedValue({ ok: false, status: 404 } as Response);

      const app = await createTestApp();
      await app.request("/v1/internal/reconcile?cleanup=false", {}, createMockEnv());

      expect(deleteSession).not.toHaveBeenCalled();
    });

    it("cleans up orphaned sessions when cleanup=true", async () => {
      const { getAllSessions, deleteSession } = await import("../../src/storage");
      const { fetchFromCore } = await import("../../src/core-client");

      vi.mocked(getAllSessions).mockResolvedValue([
        { session_id: "orphan-1", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
      ]);
      vi.mocked(fetchFromCore).mockResolvedValue({ ok: false, status: 404 } as Response);
      vi.mocked(deleteSession).mockResolvedValue(undefined);

      const app = await createTestApp();
      const res = await app.request("/v1/internal/reconcile?cleanup=true", {}, createMockEnv());

      expect(deleteSession).toHaveBeenCalledWith(expect.anything(), "orphan-1");
      const body = (await res.json()) as { cleaned: number };
      expect(body.cleaned).toBe(1);
    });

    it("only cleans up orphaned sessions, not valid ones", async () => {
      const { getAllSessions, deleteSession } = await import("../../src/storage");
      const { fetchFromCore } = await import("../../src/core-client");

      vi.mocked(getAllSessions).mockResolvedValue([
        { session_id: "valid", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
        { session_id: "orphan", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
      ]);
      vi.mocked(fetchFromCore)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response) // valid
        .mockResolvedValueOnce({ ok: false, status: 404 } as Response); // orphan
      vi.mocked(deleteSession).mockResolvedValue(undefined);

      const app = await createTestApp();
      await app.request("/v1/internal/reconcile?cleanup=true", {}, createMockEnv());

      expect(deleteSession).toHaveBeenCalledTimes(1);
      expect(deleteSession).toHaveBeenCalledWith(expect.anything(), "orphan");
      expect(deleteSession).not.toHaveBeenCalledWith(expect.anything(), "valid");
    });

    it("records errors when cleanup delete fails", async () => {
      const { getAllSessions, deleteSession } = await import("../../src/storage");
      const { fetchFromCore } = await import("../../src/core-client");

      vi.mocked(getAllSessions).mockResolvedValue([
        { session_id: "orphan-1", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
      ]);
      vi.mocked(fetchFromCore).mockResolvedValue({ ok: false, status: 404 } as Response);
      vi.mocked(deleteSession).mockRejectedValue(new Error("DB error"));

      const app = await createTestApp();
      const res = await app.request("/v1/internal/reconcile?cleanup=true", {}, createMockEnv());

      const body = (await res.json()) as { errors: string[] };
      expect(body.errors).toBeDefined();
      expect(body.errors.some((e: string) => e.includes("cleanup"))).toBe(true);
    });
  });

  describe("metrics", () => {
    it("records reconcile metric with all counts (total, valid, orphaned, cleaned, errors)", async () => {
      const { getAllSessions, deleteSession } = await import("../../src/storage");
      const { fetchFromCore } = await import("../../src/core-client");
      const { createMetrics } = await import("../../src/metrics");

      const mockMetrics = {
        sessionTouch: vi.fn(),
        reconcile: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

      vi.mocked(getAllSessions).mockResolvedValue([
        { session_id: "valid-1", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
        { session_id: "orphan-1", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
        { session_id: "orphan-2", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
      ]);
      vi.mocked(fetchFromCore)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
        .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
        .mockResolvedValueOnce({ ok: false, status: 404 } as Response);
      vi.mocked(deleteSession).mockResolvedValue(undefined);

      const app = await createTestApp();
      await app.request("/v1/internal/reconcile?cleanup=true", {}, createMockEnv());

      expect(mockMetrics.reconcile).toHaveBeenCalledWith(
        3, // total
        1, // valid
        2, // orphaned
        2, // cleaned
        0, // errors
        expect.any(Number), // latency
      );
    });

    it("records latency in reconcile metric", async () => {
      const { getAllSessions } = await import("../../src/storage");
      const { fetchFromCore } = await import("../../src/core-client");
      const { createMetrics } = await import("../../src/metrics");

      const mockMetrics = {
        sessionTouch: vi.fn(),
        reconcile: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

      vi.mocked(getAllSessions).mockResolvedValue([]);
      vi.mocked(fetchFromCore).mockResolvedValue({ ok: true, status: 200 } as Response);

      const app = await createTestApp();
      await app.request("/v1/internal/reconcile", {}, createMockEnv());

      expect(mockMetrics.reconcile).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number), // latency should be a number
      );

      // The latency should be >= 0
      const latency = mockMetrics.reconcile.mock.calls[0][5];
      expect(latency).toBeGreaterThanOrEqual(0);
    });
  });

  describe("edge cases", () => {
    it("handles empty session list", async () => {
      const { getAllSessions } = await import("../../src/storage");
      const { createMetrics } = await import("../../src/metrics");

      const mockMetrics = {
        sessionTouch: vi.fn(),
        reconcile: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

      vi.mocked(getAllSessions).mockResolvedValue([]);

      const app = await createTestApp();
      const res = await app.request("/v1/internal/reconcile", {}, createMockEnv());

      expect(res.status).toBe(200);
      const body = (await res.json()) as { totalSessions: number; validSessions: number; orphanedInD1: number };
      expect(body.totalSessions).toBe(0);
      expect(body.validSessions).toBe(0);
      expect(body.orphanedInD1).toBe(0);
    });

    it("handles all sessions being valid", async () => {
      const { getAllSessions, deleteSession } = await import("../../src/storage");
      const { fetchFromCore } = await import("../../src/core-client");

      vi.mocked(getAllSessions).mockResolvedValue([
        { session_id: "valid-1", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
        { session_id: "valid-2", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
      ]);
      vi.mocked(fetchFromCore).mockResolvedValue({ ok: true, status: 200 } as Response);

      const app = await createTestApp();
      const res = await app.request("/v1/internal/reconcile?cleanup=true", {}, createMockEnv());

      expect(deleteSession).not.toHaveBeenCalled();
      const body = (await res.json()) as { validSessions: number; orphanedInD1: number; cleaned: number };
      expect(body.validSessions).toBe(2);
      expect(body.orphanedInD1).toBe(0);
      expect(body.cleaned).toBe(0);
    });

    it("handles all sessions being orphaned", async () => {
      const { getAllSessions, deleteSession } = await import("../../src/storage");
      const { fetchFromCore } = await import("../../src/core-client");

      vi.mocked(getAllSessions).mockResolvedValue([
        { session_id: "orphan-1", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
        { session_id: "orphan-2", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
      ]);
      vi.mocked(fetchFromCore).mockResolvedValue({ ok: false, status: 404 } as Response);
      vi.mocked(deleteSession).mockResolvedValue(undefined);

      const app = await createTestApp();
      const res = await app.request("/v1/internal/reconcile?cleanup=true", {}, createMockEnv());

      expect(deleteSession).toHaveBeenCalledTimes(2);
      const body = (await res.json()) as { validSessions: number; orphanedInD1: number; cleaned: number };
      expect(body.validSessions).toBe(0);
      expect(body.orphanedInD1).toBe(2);
      expect(body.cleaned).toBe(2);
    });

    it("continues processing after individual session check fails", async () => {
      const { getAllSessions, deleteSession } = await import("../../src/storage");
      const { fetchFromCore } = await import("../../src/core-client");

      vi.mocked(getAllSessions).mockResolvedValue([
        { session_id: "session-1", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
        { session_id: "session-2", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
        { session_id: "session-3", created_at: 1000, last_active_at: 2000, ttl_seconds: 1800, marked_for_deletion_at: null },
      ]);
      vi.mocked(fetchFromCore)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response) // session-1: valid
        .mockRejectedValueOnce(new Error("timeout")) // session-2: error
        .mockResolvedValueOnce({ ok: false, status: 404 } as Response); // session-3: orphan
      vi.mocked(deleteSession).mockResolvedValue(undefined);

      const app = await createTestApp();
      const res = await app.request("/v1/internal/reconcile?cleanup=true", {}, createMockEnv());

      const body = (await res.json()) as { validSessions: number; orphanedInD1: number; errors: string[] };
      expect(body.validSessions).toBe(1);
      expect(body.orphanedInD1).toBe(1);
      expect(body.errors).toHaveLength(1);
      expect(deleteSession).toHaveBeenCalledWith(expect.anything(), "session-3");
    });
  });
});
