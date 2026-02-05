import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the analytics queries module
vi.mock("../src/analytics-queries", () => ({
  getExpiredSessions: vi.fn().mockResolvedValue({ data: [], error: undefined }),
  getSessionSubscriptions: vi.fn().mockResolvedValue({ data: [], error: undefined }),
}));

vi.mock("../src/metrics", () => ({
  createMetrics: vi.fn(() => ({
    sessionExpire: vi.fn(),
    sessionDelete: vi.fn(),
    cleanupBatch: vi.fn(),
  })),
}));

// Mock fetch for core requests
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  describe("cleanupExpiredSessions", () => {
    it("should skip cleanup if Analytics credentials are not configured", async () => {
      const { cleanupExpiredSessions } = await import("../src/cleanup");

      const env = {
        CORE_URL: "http://localhost:8787",
        SUBSCRIPTION_DO: {} as DurableObjectNamespace,
        // No ACCOUNT_ID or API_TOKEN
      };

      const result = await cleanupExpiredSessions(env);

      expect(result.deleted).toBe(0);
      expect(result.streamDeleteSuccesses).toBe(0);
      expect(result.streamDeleteFailures).toBe(0);
    });

    it("should return early if no expired sessions found", async () => {
      const { getExpiredSessions } = await import("../src/analytics-queries");
      vi.mocked(getExpiredSessions).mockResolvedValue({ data: [], error: undefined });

      const { cleanupExpiredSessions } = await import("../src/cleanup");

      const env = {
        CORE_URL: "http://localhost:8787",
        SUBSCRIPTION_DO: {} as DurableObjectNamespace,
        ACCOUNT_ID: "test-account",
        API_TOKEN: "test-token",
        ANALYTICS_DATASET: "test_metrics",
      };

      const result = await cleanupExpiredSessions(env);

      expect(result.deleted).toBe(0);
      expect(getExpiredSessions).toHaveBeenCalledWith(
        { ACCOUNT_ID: "test-account", API_TOKEN: "test-token" },
        "test_metrics",
      );
    });

    it("should clean up expired sessions", async () => {
      const { getExpiredSessions, getSessionSubscriptions } = await import(
        "../src/analytics-queries"
      );

      vi.mocked(getExpiredSessions).mockResolvedValue({
        data: [{ sessionId: "session-1", lastActivity: Date.now() - 3600000, ttlSeconds: 1800 }],
        error: undefined,
      });

      vi.mocked(getSessionSubscriptions).mockResolvedValue({
        data: [{ streamId: "stream-a" }, { streamId: "stream-b" }],
        error: undefined,
      });

      // Mock DO fetch
      const mockDoFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ removed: true })));
      const mockDoStub = { fetch: mockDoFetch };
      const mockDoNamespace = {
        idFromName: vi.fn().mockReturnValue("do-id"),
        get: vi.fn().mockReturnValue(mockDoStub),
      };

      // Mock core fetch for session deletion
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

      const { cleanupExpiredSessions } = await import("../src/cleanup");

      const env = {
        CORE_URL: "http://localhost:8787",
        SUBSCRIPTION_DO: mockDoNamespace as unknown as DurableObjectNamespace,
        ACCOUNT_ID: "test-account",
        API_TOKEN: "test-token",
        ANALYTICS_DATASET: "test_metrics",
      };

      const result = await cleanupExpiredSessions(env);

      expect(result.deleted).toBe(1);
      expect(result.subscriptionRemoveSuccesses).toBe(2);
      expect(result.streamDeleteSuccesses).toBe(1);

      // Verify DO was called to remove subscriptions
      expect(mockDoFetch).toHaveBeenCalledTimes(2);

      // Verify core was called to delete session stream
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/stream/session:session-1"),
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("should handle DO fetch failures gracefully", async () => {
      const { getExpiredSessions, getSessionSubscriptions } = await import(
        "../src/analytics-queries"
      );

      vi.mocked(getExpiredSessions).mockResolvedValue({
        data: [{ sessionId: "session-1", lastActivity: Date.now() - 3600000, ttlSeconds: 1800 }],
        error: undefined,
      });

      vi.mocked(getSessionSubscriptions).mockResolvedValue({
        data: [{ streamId: "stream-a" }],
        error: undefined,
      });

      // Mock DO fetch to fail
      const mockDoFetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
      const mockDoStub = { fetch: mockDoFetch };
      const mockDoNamespace = {
        idFromName: vi.fn().mockReturnValue("do-id"),
        get: vi.fn().mockReturnValue(mockDoStub),
      };

      // Mock core fetch
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

      const { cleanupExpiredSessions } = await import("../src/cleanup");

      const env = {
        CORE_URL: "http://localhost:8787",
        SUBSCRIPTION_DO: mockDoNamespace as unknown as DurableObjectNamespace,
        ACCOUNT_ID: "test-account",
        API_TOKEN: "test-token",
      };

      const result = await cleanupExpiredSessions(env);

      expect(result.deleted).toBe(1);
      expect(result.subscriptionRemoveFailures).toBe(1);
      expect(result.streamDeleteSuccesses).toBe(1);
    });

    it("should handle core deletion failures gracefully", async () => {
      const { getExpiredSessions, getSessionSubscriptions } = await import(
        "../src/analytics-queries"
      );

      vi.mocked(getExpiredSessions).mockResolvedValue({
        data: [{ sessionId: "session-1", lastActivity: Date.now() - 3600000, ttlSeconds: 1800 }],
        error: undefined,
      });

      vi.mocked(getSessionSubscriptions).mockResolvedValue({ data: [], error: undefined });

      // Mock core fetch to fail
      mockFetch.mockResolvedValue(new Response(null, { status: 500 }));

      const { cleanupExpiredSessions } = await import("../src/cleanup");

      const env = {
        CORE_URL: "http://localhost:8787",
        SUBSCRIPTION_DO: {} as DurableObjectNamespace,
        ACCOUNT_ID: "test-account",
        API_TOKEN: "test-token",
      };

      const result = await cleanupExpiredSessions(env);

      expect(result.deleted).toBe(1);
      expect(result.streamDeleteFailures).toBe(1);
    });

    it("should treat 404 from core as success (already deleted)", async () => {
      const { getExpiredSessions, getSessionSubscriptions } = await import(
        "../src/analytics-queries"
      );

      vi.mocked(getExpiredSessions).mockResolvedValue({
        data: [{ sessionId: "session-1", lastActivity: Date.now() - 3600000, ttlSeconds: 1800 }],
        error: undefined,
      });

      vi.mocked(getSessionSubscriptions).mockResolvedValue({ data: [], error: undefined });

      // Mock core fetch to return 404
      mockFetch.mockResolvedValue(new Response(null, { status: 404 }));

      const { cleanupExpiredSessions } = await import("../src/cleanup");

      const env = {
        CORE_URL: "http://localhost:8787",
        SUBSCRIPTION_DO: {} as DurableObjectNamespace,
        ACCOUNT_ID: "test-account",
        API_TOKEN: "test-token",
      };

      const result = await cleanupExpiredSessions(env);

      expect(result.deleted).toBe(1);
      expect(result.streamDeleteSuccesses).toBe(1);
    });

    it("should use default dataset name if not provided", async () => {
      const { getExpiredSessions } = await import("../src/analytics-queries");
      vi.mocked(getExpiredSessions).mockResolvedValue({ data: [], error: undefined });

      const { cleanupExpiredSessions } = await import("../src/cleanup");

      const env = {
        CORE_URL: "http://localhost:8787",
        SUBSCRIPTION_DO: {} as DurableObjectNamespace,
        ACCOUNT_ID: "test-account",
        API_TOKEN: "test-token",
        // No ANALYTICS_DATASET - should use default
      };

      await cleanupExpiredSessions(env);

      expect(getExpiredSessions).toHaveBeenCalledWith(
        { ACCOUNT_ID: "test-account", API_TOKEN: "test-token" },
        "subscriptions_metrics", // default value
      );
    });

    it("should handle analytics query errors gracefully", async () => {
      const { getExpiredSessions } = await import("../src/analytics-queries");
      vi.mocked(getExpiredSessions).mockResolvedValue({
        data: [],
        error: "Analytics Engine query failed",
        errorType: "query",
      });

      const { cleanupExpiredSessions } = await import("../src/cleanup");

      const env = {
        CORE_URL: "http://localhost:8787",
        SUBSCRIPTION_DO: {} as DurableObjectNamespace,
        ACCOUNT_ID: "test-account",
        API_TOKEN: "test-token",
      };

      const result = await cleanupExpiredSessions(env);

      expect(result.deleted).toBe(0);
      expect(result.streamDeleteSuccesses).toBe(0);
    });
  });

  describe("cleanup metrics", () => {
    it("reports correct subscription removal stats", async () => {
      const { getExpiredSessions, getSessionSubscriptions } = await import(
        "../src/analytics-queries"
      );
      const { createMetrics } = await import("../src/metrics");

      // Setup: 1 expired session with 2 subscriptions
      vi.mocked(getExpiredSessions).mockResolvedValue({
        data: [{ sessionId: "session-1", lastActivity: Date.now() - 3600000, ttlSeconds: 1800 }],
        error: undefined,
      });

      vi.mocked(getSessionSubscriptions).mockResolvedValue({
        data: [{ streamId: "stream-a" }, { streamId: "stream-b" }],
        error: undefined,
      });

      // Mock DO fetch - first succeeds, second fails
      const mockDoFetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ removed: true })))
        .mockResolvedValueOnce(new Response(null, { status: 500 }));
      const mockDoStub = { fetch: mockDoFetch };
      const mockDoNamespace = {
        idFromName: vi.fn().mockReturnValue("do-id"),
        get: vi.fn().mockReturnValue(mockDoStub),
      };

      // Mock core fetch
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

      const { cleanupExpiredSessions } = await import("../src/cleanup");

      const env = {
        CORE_URL: "http://localhost:8787",
        SUBSCRIPTION_DO: mockDoNamespace as unknown as DurableObjectNamespace,
        ACCOUNT_ID: "test-account",
        API_TOKEN: "test-token",
      };

      const result = await cleanupExpiredSessions(env);

      // Verify counts: 1 expired, 1 stream deleted, 1 sub succeeded, 1 sub failed
      expect(result.deleted).toBe(1);
      expect(result.streamDeleteSuccesses).toBe(1);
      expect(result.subscriptionRemoveSuccesses).toBe(1);
      expect(result.subscriptionRemoveFailures).toBe(1);
    });
  });
});
