import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppEnv } from "../src/env";

// Mock the analytics queries module
vi.mock("../src/analytics", () => ({
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

// Mock fetch for core requests (fetchFromCore falls back to global fetch)
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const PROJECT_ID = "test-project";
const SESSION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

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
        SUBSCRIPTION_DO: {} as AppEnv["SUBSCRIPTION_DO"],
        // No ACCOUNT_ID or API_TOKEN
      };

      const result = await cleanupExpiredSessions(env);

      expect(result.deleted).toBe(0);
      expect(result.streamDeleteSuccesses).toBe(0);
      expect(result.streamDeleteFailures).toBe(0);
    });

    it("should return early if no expired sessions found", async () => {
      const { getExpiredSessions } = await import("../src/analytics");
      vi.mocked(getExpiredSessions).mockResolvedValue({ data: [], error: undefined });

      const { cleanupExpiredSessions } = await import("../src/cleanup");

      const env = {
        CORE_URL: "http://localhost:8787",
        SUBSCRIPTION_DO: {} as AppEnv["SUBSCRIPTION_DO"],
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
        "../src/analytics"
      );

      vi.mocked(getExpiredSessions).mockResolvedValue({
        data: [{ sessionId: SESSION_ID, project: PROJECT_ID, lastActivity: Date.now() - 3600000, ttlSeconds: 1800 }],
        error: undefined,
      });

      vi.mocked(getSessionSubscriptions).mockResolvedValue({
        data: [{ streamId: "stream-a" }, { streamId: "stream-b" }],
        error: undefined,
      });

      // Mock DO RPC - removeSubscriber succeeds
      const mockRemoveSubscriber = vi.fn().mockResolvedValue(undefined);
      const mockDoStub = { removeSubscriber: mockRemoveSubscriber };
      const mockDoNamespace = {
        idFromName: vi.fn().mockReturnValue("do-id"),
        get: vi.fn().mockReturnValue(mockDoStub),
      };

      // Mock core fetch for session deletion
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

      const { cleanupExpiredSessions } = await import("../src/cleanup");

      const env = {
        CORE_URL: "http://localhost:8787",
        SUBSCRIPTION_DO: mockDoNamespace as unknown as AppEnv["SUBSCRIPTION_DO"],
        ACCOUNT_ID: "test-account",
        API_TOKEN: "test-token",
        ANALYTICS_DATASET: "test_metrics",
      };

      const result = await cleanupExpiredSessions(env);

      expect(result.deleted).toBe(1);
      expect(result.subscriptionRemoveSuccesses).toBe(2);
      expect(result.streamDeleteSuccesses).toBe(1);

      // Verify DO RPC was called to remove subscriptions
      expect(mockRemoveSubscriber).toHaveBeenCalledTimes(2);
      expect(mockRemoveSubscriber).toHaveBeenCalledWith(SESSION_ID);

      // Verify core was called to delete session stream (project-scoped path)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/v1/${PROJECT_ID}/stream/${SESSION_ID}`),
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("should handle DO RPC failures gracefully", async () => {
      const { getExpiredSessions, getSessionSubscriptions } = await import(
        "../src/analytics"
      );

      vi.mocked(getExpiredSessions).mockResolvedValue({
        data: [{ sessionId: SESSION_ID, project: PROJECT_ID, lastActivity: Date.now() - 3600000, ttlSeconds: 1800 }],
        error: undefined,
      });

      vi.mocked(getSessionSubscriptions).mockResolvedValue({
        data: [{ streamId: "stream-a" }],
        error: undefined,
      });

      // Mock DO RPC to fail
      const mockRemoveSubscriber = vi.fn().mockRejectedValue(new Error("DO error"));
      const mockDoStub = { removeSubscriber: mockRemoveSubscriber };
      const mockDoNamespace = {
        idFromName: vi.fn().mockReturnValue("do-id"),
        get: vi.fn().mockReturnValue(mockDoStub),
      };

      // Mock core fetch
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

      const { cleanupExpiredSessions } = await import("../src/cleanup");

      const env = {
        CORE_URL: "http://localhost:8787",
        SUBSCRIPTION_DO: mockDoNamespace as unknown as AppEnv["SUBSCRIPTION_DO"],
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
        "../src/analytics"
      );

      vi.mocked(getExpiredSessions).mockResolvedValue({
        data: [{ sessionId: SESSION_ID, project: PROJECT_ID, lastActivity: Date.now() - 3600000, ttlSeconds: 1800 }],
        error: undefined,
      });

      vi.mocked(getSessionSubscriptions).mockResolvedValue({ data: [], error: undefined });

      // Mock core fetch to fail
      mockFetch.mockResolvedValue(new Response(null, { status: 500 }));

      const { cleanupExpiredSessions } = await import("../src/cleanup");

      const env = {
        CORE_URL: "http://localhost:8787",
        SUBSCRIPTION_DO: {} as AppEnv["SUBSCRIPTION_DO"],
        ACCOUNT_ID: "test-account",
        API_TOKEN: "test-token",
      };

      const result = await cleanupExpiredSessions(env);

      expect(result.deleted).toBe(1);
      expect(result.streamDeleteFailures).toBe(1);
    });

    it("should treat 404 from core as success (already deleted)", async () => {
      const { getExpiredSessions, getSessionSubscriptions } = await import(
        "../src/analytics"
      );

      vi.mocked(getExpiredSessions).mockResolvedValue({
        data: [{ sessionId: SESSION_ID, project: PROJECT_ID, lastActivity: Date.now() - 3600000, ttlSeconds: 1800 }],
        error: undefined,
      });

      vi.mocked(getSessionSubscriptions).mockResolvedValue({ data: [], error: undefined });

      // Mock core fetch to return 404
      mockFetch.mockResolvedValue(new Response(null, { status: 404 }));

      const { cleanupExpiredSessions } = await import("../src/cleanup");

      const env = {
        CORE_URL: "http://localhost:8787",
        SUBSCRIPTION_DO: {} as AppEnv["SUBSCRIPTION_DO"],
        ACCOUNT_ID: "test-account",
        API_TOKEN: "test-token",
      };

      const result = await cleanupExpiredSessions(env);

      expect(result.deleted).toBe(1);
      expect(result.streamDeleteSuccesses).toBe(1);
    });

    it("should use default dataset name if not provided", async () => {
      const { getExpiredSessions } = await import("../src/analytics");
      vi.mocked(getExpiredSessions).mockResolvedValue({ data: [], error: undefined });

      const { cleanupExpiredSessions } = await import("../src/cleanup");

      const env = {
        CORE_URL: "http://localhost:8787",
        SUBSCRIPTION_DO: {} as AppEnv["SUBSCRIPTION_DO"],
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
      const { getExpiredSessions } = await import("../src/analytics");
      vi.mocked(getExpiredSessions).mockResolvedValue({
        data: [],
        error: "Analytics Engine query failed",
        errorType: "query",
      });

      const { cleanupExpiredSessions } = await import("../src/cleanup");

      const env = {
        CORE_URL: "http://localhost:8787",
        SUBSCRIPTION_DO: {} as AppEnv["SUBSCRIPTION_DO"],
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
        "../src/analytics"
      );

      // Setup: 1 expired session with 2 subscriptions
      vi.mocked(getExpiredSessions).mockResolvedValue({
        data: [{ sessionId: SESSION_ID, project: PROJECT_ID, lastActivity: Date.now() - 3600000, ttlSeconds: 1800 }],
        error: undefined,
      });

      vi.mocked(getSessionSubscriptions).mockResolvedValue({
        data: [{ streamId: "stream-a" }, { streamId: "stream-b" }],
        error: undefined,
      });

      // Mock DO RPC - first succeeds, second fails
      const mockRemoveSubscriber = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("DO error"));
      const mockDoStub = { removeSubscriber: mockRemoveSubscriber };
      const mockDoNamespace = {
        idFromName: vi.fn().mockReturnValue("do-id"),
        get: vi.fn().mockReturnValue(mockDoStub),
      };

      // Mock core fetch
      mockFetch.mockResolvedValue(new Response(null, { status: 200 }));

      const { cleanupExpiredSessions } = await import("../src/cleanup");

      const env = {
        CORE_URL: "http://localhost:8787",
        SUBSCRIPTION_DO: mockDoNamespace as unknown as AppEnv["SUBSCRIPTION_DO"],
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
