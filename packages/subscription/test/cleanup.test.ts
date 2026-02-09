import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";

// Mock only getExpiredSessions — Analytics Engine HTTP API is unavailable in vitest pool workers
vi.mock("../src/analytics", () => ({
  getExpiredSessions: vi.fn().mockResolvedValue({ data: [], error: undefined }),
}));

const PROJECT_ID = "test-project";

describe("cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("cleanupExpiredSessions", () => {
    it("should skip cleanup if Analytics credentials are not configured", async () => {
      const { cleanupExpiredSessions } = await import("../src/cleanup");

      // env doesn't have ACCOUNT_ID or API_TOKEN by default
      const result = await cleanupExpiredSessions(env as never);

      expect(result.deleted).toBe(0);
      expect(result.streamDeleteSuccesses).toBe(0);
      expect(result.streamDeleteFailures).toBe(0);
    });

    it("should return early if no expired sessions found", async () => {
      const { getExpiredSessions } = await import("../src/analytics");
      vi.mocked(getExpiredSessions).mockResolvedValue({ data: [], error: undefined });

      const { cleanupExpiredSessions } = await import("../src/cleanup");

      const testEnv = { ...env, ACCOUNT_ID: "test-account", API_TOKEN: "test-token", ANALYTICS_DATASET: "test_metrics" };
      const result = await cleanupExpiredSessions(testEnv as never);

      expect(result.deleted).toBe(0);
      expect(getExpiredSessions).toHaveBeenCalledWith(
        { ACCOUNT_ID: "test-account", API_TOKEN: "test-token" },
        "test_metrics",
      );
    });

    it("should clean up expired sessions", async () => {
      const sessionId = crypto.randomUUID();
      const streamA = `stream-${crypto.randomUUID()}`;
      const streamB = `stream-${crypto.randomUUID()}`;

      // Set up real data: session stream + source streams
      await env.CORE.putStream(`${PROJECT_ID}/${sessionId}`, { contentType: "application/octet-stream" });
      await env.CORE.putStream(`${PROJECT_ID}/${streamA}`, { contentType: "application/json" });
      await env.CORE.putStream(`${PROJECT_ID}/${streamB}`, { contentType: "application/json" });

      // Add subscriptions to SessionDO (so cleanup can discover them)
      const sessionDoKey = `${PROJECT_ID}/${sessionId}`;
      const sessionStub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionDoKey));
      await sessionStub.addSubscription(streamA);
      await sessionStub.addSubscription(streamB);

      // Add subscriber to SubscriptionDOs (so cleanup can remove them)
      const subStubA = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(`${PROJECT_ID}/${streamA}`));
      await subStubA.addSubscriber(sessionId);
      const subStubB = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(`${PROJECT_ID}/${streamB}`));
      await subStubB.addSubscriber(sessionId);

      // Mock getExpiredSessions to return our session
      const { getExpiredSessions } = await import("../src/analytics");
      vi.mocked(getExpiredSessions).mockResolvedValue({
        data: [{ sessionId, project: PROJECT_ID, lastActivity: Date.now() - 3600000, ttlSeconds: 1800 }],
        error: undefined,
      });

      const { cleanupExpiredSessions } = await import("../src/cleanup");
      const testEnv = { ...env, ACCOUNT_ID: "test-account", API_TOKEN: "test-token" };

      const result = await cleanupExpiredSessions(testEnv as never);

      expect(result.deleted).toBe(1);
      expect(result.subscriptionRemoveSuccesses).toBe(2);
      expect(result.streamDeleteSuccesses).toBe(1);

      // Verify session stream was actually deleted
      const headResult = await env.CORE.headStream(`${PROJECT_ID}/${sessionId}`);
      expect(headResult.ok).toBe(false);

      // Verify subscribers were removed from SubscriptionDOs
      const subsA = await subStubA.getSubscribers(`${PROJECT_ID}/${streamA}`);
      expect(subsA.count).toBe(0);
      const subsB = await subStubB.getSubscribers(`${PROJECT_ID}/${streamB}`);
      expect(subsB.count).toBe(0);
    });

    it("should handle SubscriptionDO RPC failures gracefully", async () => {
      const sessionId = crypto.randomUUID();
      const streamA = `stream-${crypto.randomUUID()}`;

      // Set up real session stream
      await env.CORE.putStream(`${PROJECT_ID}/${sessionId}`, { contentType: "application/octet-stream" });

      // Add subscription to SessionDO
      const sessionDoKey = `${PROJECT_ID}/${sessionId}`;
      const sessionStub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionDoKey));
      await sessionStub.addSubscription(streamA);

      const { getExpiredSessions } = await import("../src/analytics");
      vi.mocked(getExpiredSessions).mockResolvedValue({
        data: [{ sessionId, project: PROJECT_ID, lastActivity: Date.now() - 3600000, ttlSeconds: 1800 }],
        error: undefined,
      });

      // Mock SUBSCRIPTION_DO to fail — simulates DO error that can't be triggered naturally
      const failEnv = {
        ...env,
        ACCOUNT_ID: "test-account",
        API_TOKEN: "test-token",
        SUBSCRIPTION_DO: {
          idFromName: env.SUBSCRIPTION_DO.idFromName.bind(env.SUBSCRIPTION_DO),
          get: vi.fn().mockReturnValue({ removeSubscriber: vi.fn().mockRejectedValue(new Error("DO error")) }),
        },
      };

      const { cleanupExpiredSessions } = await import("../src/cleanup");
      const result = await cleanupExpiredSessions(failEnv as never);

      expect(result.deleted).toBe(1);
      expect(result.subscriptionRemoveFailures).toBe(1);
      expect(result.streamDeleteSuccesses).toBe(1);
    });

    it("should handle core deletion failures gracefully", async () => {
      const sessionId = crypto.randomUUID();

      const { getExpiredSessions } = await import("../src/analytics");
      vi.mocked(getExpiredSessions).mockResolvedValue({
        data: [{ sessionId, project: PROJECT_ID, lastActivity: Date.now() - 3600000, ttlSeconds: 1800 }],
        error: undefined,
      });

      // Mock CORE.deleteStream to return 500 — simulates server error that can't be triggered naturally
      const failEnv = {
        ...env,
        ACCOUNT_ID: "test-account",
        API_TOKEN: "test-token",
        CORE: {
          ...env.CORE,
          deleteStream: vi.fn().mockResolvedValue({ ok: false, status: 500, body: "Internal Server Error" }),
        },
      };

      const { cleanupExpiredSessions } = await import("../src/cleanup");
      const result = await cleanupExpiredSessions(failEnv as never);

      expect(result.deleted).toBe(1);
      expect(result.streamDeleteFailures).toBe(1);
    });

    it("should treat 404 from core as success (already deleted)", async () => {
      // Session stream doesn't exist — deleteStream will naturally return 404
      const sessionId = crypto.randomUUID();

      const { getExpiredSessions } = await import("../src/analytics");
      vi.mocked(getExpiredSessions).mockResolvedValue({
        data: [{ sessionId, project: PROJECT_ID, lastActivity: Date.now() - 3600000, ttlSeconds: 1800 }],
        error: undefined,
      });

      const { cleanupExpiredSessions } = await import("../src/cleanup");
      const testEnv = { ...env, ACCOUNT_ID: "test-account", API_TOKEN: "test-token" };

      const result = await cleanupExpiredSessions(testEnv as never);

      expect(result.deleted).toBe(1);
      expect(result.streamDeleteSuccesses).toBe(1);
    });

    it("should use default dataset name if not provided", async () => {
      const { getExpiredSessions } = await import("../src/analytics");
      vi.mocked(getExpiredSessions).mockResolvedValue({ data: [], error: undefined });

      const { cleanupExpiredSessions } = await import("../src/cleanup");
      const testEnv = { ...env, ACCOUNT_ID: "test-account", API_TOKEN: "test-token" };

      await cleanupExpiredSessions(testEnv as never);

      expect(getExpiredSessions).toHaveBeenCalledWith(
        { ACCOUNT_ID: "test-account", API_TOKEN: "test-token" },
        "subscriptions_metrics",
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
      const testEnv = { ...env, ACCOUNT_ID: "test-account", API_TOKEN: "test-token" };

      const result = await cleanupExpiredSessions(testEnv as never);

      expect(result.deleted).toBe(0);
      expect(result.streamDeleteSuccesses).toBe(0);
    });
  });

  describe("cleanup metrics", () => {
    it("reports correct subscription removal stats", async () => {
      const sessionId = crypto.randomUUID();
      const streamA = `stream-${crypto.randomUUID()}`;
      const streamB = `stream-${crypto.randomUUID()}`;

      // Set up real session stream
      await env.CORE.putStream(`${PROJECT_ID}/${sessionId}`, { contentType: "application/octet-stream" });

      // Add subscriptions to SessionDO
      const sessionDoKey = `${PROJECT_ID}/${sessionId}`;
      const sessionStub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionDoKey));
      await sessionStub.addSubscription(streamA);
      await sessionStub.addSubscription(streamB);

      const { getExpiredSessions } = await import("../src/analytics");
      vi.mocked(getExpiredSessions).mockResolvedValue({
        data: [{ sessionId, project: PROJECT_ID, lastActivity: Date.now() - 3600000, ttlSeconds: 1800 }],
        error: undefined,
      });

      // Mock SUBSCRIPTION_DO: first removeSubscriber succeeds, second fails (error path)
      const mockRemoveSubscriber = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("DO error"));

      const testEnv = {
        ...env,
        ACCOUNT_ID: "test-account",
        API_TOKEN: "test-token",
        SUBSCRIPTION_DO: {
          idFromName: env.SUBSCRIPTION_DO.idFromName.bind(env.SUBSCRIPTION_DO),
          get: vi.fn().mockReturnValue({ removeSubscriber: mockRemoveSubscriber }),
        },
      };

      const { cleanupExpiredSessions } = await import("../src/cleanup");
      const result = await cleanupExpiredSessions(testEnv as never);

      expect(result.deleted).toBe(1);
      expect(result.streamDeleteSuccesses).toBe(1);
      expect(result.subscriptionRemoveSuccesses).toBe(1);
      expect(result.subscriptionRemoveFailures).toBe(1);
    });
  });
});
