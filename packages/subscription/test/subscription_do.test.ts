import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestSqlStorage } from "./helpers/sql-storage";

// Mock fetchFromCore
const mockFetchFromCore = vi.fn();
vi.mock("../src/client", () => ({
  fetchFromCore: (...args: unknown[]) => mockFetchFromCore(...args),
}));

// Mock fanoutToSubscribers
const mockFanoutToSubscribers = vi.fn();
vi.mock("../src/subscriptions/fanout", () => ({
  fanoutToSubscribers: (...args: unknown[]) => mockFanoutToSubscribers(...args),
}));

// Mock metrics
const mockMetrics = {
  publish: vi.fn(),
  publishError: vi.fn(),
  fanout: vi.fn(),
  fanoutQueued: vi.fn(),
};
vi.mock("../src/metrics", () => ({
  createMetrics: vi.fn(() => mockMetrics),
}));

// Mock DurableObject base class
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    protected env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const PROJECT_ID = "test-project";

function createMockState(sqlStorage: Awaited<ReturnType<typeof createTestSqlStorage>>) {
  return {
    storage: { sql: sqlStorage },
    blockConcurrencyWhile: vi.fn((fn: () => void) => fn()),
  };
}

function createMockEnv(overrides: Record<string, unknown> = {}) {
  return {
    CORE_URL: "http://localhost:8787",
    METRICS: undefined,
    ...overrides,
  };
}

describe("SubscriptionDO", () => {
  let mockState: ReturnType<typeof createMockState>;
  let mockEnv: ReturnType<typeof createMockEnv>;

  beforeEach(async () => {
    const sqlStorage = await createTestSqlStorage();
    mockState = createMockState(sqlStorage);
    mockEnv = createMockEnv();
    vi.clearAllMocks();
    mockFetchFromCore.mockReset();
    mockFanoutToSubscribers.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe("initialization", () => {
    it("should create subscribers table on init", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      expect(mockState.blockConcurrencyWhile).toHaveBeenCalled();
    });
  });

  describe("addSubscriber", () => {
    it("should add a subscriber", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      await dobj.addSubscriber("session-123");

      const result = await dobj.getSubscribers("test-stream");
      expect(result.count).toBe(1);
      expect(result.subscribers[0].sessionId).toBe("session-123");
    });

    it("should not duplicate on re-add", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      await dobj.addSubscriber("session-123");
      await dobj.addSubscriber("session-123");

      const result = await dobj.getSubscribers("test-stream");
      expect(result.count).toBe(1);
    });
  });

  describe("removeSubscriber", () => {
    it("should remove a subscriber", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      await dobj.addSubscriber("session-123");
      await dobj.removeSubscriber("session-123");

      const result = await dobj.getSubscribers("test-stream");
      expect(result.count).toBe(0);
    });
  });

  describe("removeSubscribers", () => {
    it("should remove multiple subscribers", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      await dobj.addSubscriber("s1");
      await dobj.addSubscriber("s2");
      await dobj.addSubscriber("s3");
      await dobj.removeSubscribers(["s1", "s3"]);

      const result = await dobj.getSubscribers("test-stream");
      expect(result.count).toBe(1);
      expect(result.subscribers[0].sessionId).toBe("s2");
    });
  });

  describe("getSubscribers", () => {
    it("should return all subscribers", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      await dobj.addSubscriber("session-1");
      await dobj.addSubscriber("session-2");

      const result = await dobj.getSubscribers("test-stream");

      expect(result.count).toBe(2);
      expect(result.subscribers).toHaveLength(2);
      expect(result.streamId).toBe("test-stream");
    });
  });

  describe("publish", () => {
    it("should write to core and fanout to subscribers with inline mode", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      await dobj.addSubscriber("session-1");
      await dobj.addSubscriber("session-2");

      // Mock core write success
      mockFetchFromCore.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Stream-Next-Offset": "5" },
        }),
      );

      // Mock fanout
      mockFanoutToSubscribers.mockResolvedValueOnce({
        successes: 2,
        failures: 0,
        staleSessionIds: [],
      });

      const result = await dobj.publish(PROJECT_ID, "test-stream", {
        payload: new TextEncoder().encode(JSON.stringify({ message: "hello" })).buffer as ArrayBuffer,
        contentType: "application/json",
      });

      expect(result.status).toBe(200);
      expect(result.fanoutCount).toBe(2);
      expect(result.fanoutSuccesses).toBe(2);
      expect(result.fanoutFailures).toBe(0);
      expect(result.fanoutMode).toBe("inline");

      // Verify core write was called (project-scoped path)
      expect(mockFetchFromCore).toHaveBeenCalledWith(
        mockEnv,
        `/v1/${PROJECT_ID}/stream/test-stream`,
        expect.objectContaining({ method: "POST" }),
      );

      // Verify shared fanout function was called
      expect(mockFanoutToSubscribers).toHaveBeenCalledTimes(1);
    });

    it("should return error when core write fails with inline mode", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      await dobj.addSubscriber("session-1");

      // Mock core write failure
      mockFetchFromCore.mockResolvedValueOnce(
        new Response("Internal error", { status: 500 }),
      );

      const result = await dobj.publish(PROJECT_ID, "test-stream", {
        payload: new TextEncoder().encode(JSON.stringify({ message: "hello" })).buffer as ArrayBuffer,
        contentType: "application/json",
      });

      expect(result.status).toBe(500);
      expect(result.fanoutMode).toBe("inline");
      expect(JSON.parse(result.body).error).toBe("Failed to write to stream");

      // Verify no fanout was attempted
      expect(mockFanoutToSubscribers).not.toHaveBeenCalled();
    });

    it("should forward producer headers to core", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      // Mock core write success
      mockFetchFromCore.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      mockFanoutToSubscribers.mockResolvedValueOnce({ successes: 0, failures: 0, staleSessionIds: [] });

      await dobj.publish(PROJECT_ID, "test-stream", {
        payload: new TextEncoder().encode(JSON.stringify({ message: "hello" })).buffer as ArrayBuffer,
        contentType: "application/json",
        producerId: "producer-123",
        producerEpoch: "1",
        producerSeq: "42",
      });

      expect(mockFetchFromCore).toHaveBeenCalledWith(
        mockEnv,
        `/v1/${PROJECT_ID}/stream/test-stream`,
        expect.objectContaining({
          headers: expect.objectContaining({
            "Producer-Id": "producer-123",
            "Producer-Epoch": "1",
            "Producer-Seq": "42",
          }),
        }),
      );
    });

    it("should use fanout producer headers with source offset", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      await dobj.addSubscriber("session-1");

      // Mock core write success with offset
      mockFetchFromCore.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Stream-Next-Offset": "99" },
        }),
      );

      mockFanoutToSubscribers.mockResolvedValueOnce({ successes: 1, failures: 0, staleSessionIds: [] });

      await dobj.publish(PROJECT_ID, "my-stream", {
        payload: new TextEncoder().encode(JSON.stringify({ message: "hello" })).buffer as ArrayBuffer,
        contentType: "application/json",
      });

      // Verify fanout used correct producer headers (with projectId as second arg)
      expect(mockFanoutToSubscribers).toHaveBeenCalledWith(
        mockEnv,
        PROJECT_ID,
        ["session-1"],
        expect.any(ArrayBuffer),
        "application/json",
        {
          "Producer-Id": "fanout:my-stream",
          "Producer-Epoch": "1",
          "Producer-Seq": "99",
        },
      );
    });

    it("should remove stale subscriber when fanout returns 404", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      await dobj.addSubscriber("active-session");
      await dobj.addSubscriber("stale-session");

      const before = await dobj.getSubscribers("test-stream");
      expect(before.count).toBe(2);

      // Mock core write success
      mockFetchFromCore.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Stream-Next-Offset": "5" },
        }),
      );

      // Mock fanout with stale session
      mockFanoutToSubscribers.mockResolvedValueOnce({
        successes: 1,
        failures: 1,
        staleSessionIds: ["stale-session"],
      });

      const result = await dobj.publish(PROJECT_ID, "test-stream", {
        payload: new TextEncoder().encode(JSON.stringify({ message: "hello" })).buffer as ArrayBuffer,
        contentType: "application/json",
      });

      expect(result.status).toBe(200);
      expect(result.fanoutSuccesses).toBe(1);
      expect(result.fanoutFailures).toBe(1);
      expect(result.fanoutMode).toBe("inline");

      // Verify stale subscriber was removed via getSubscribers
      const after = await dobj.getSubscribers("test-stream");
      expect(after.count).toBe(1);
      expect(after.subscribers[0].sessionId).toBe("active-session");
    });

    it("should record metrics correctly", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      await dobj.addSubscriber("session-1");

      // Mock core write success
      mockFetchFromCore.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      mockFanoutToSubscribers.mockResolvedValueOnce({ successes: 1, failures: 0, staleSessionIds: [] });

      await dobj.publish(PROJECT_ID, "test-stream", {
        payload: new TextEncoder().encode(JSON.stringify({ message: "hello" })).buffer as ArrayBuffer,
        contentType: "application/json",
      });

      expect(mockMetrics.publish).toHaveBeenCalledWith(
        "test-stream",
        1, // subscriber count
        expect.any(Number), // latency
      );

      expect(mockMetrics.fanout).toHaveBeenCalledWith({
        streamId: "test-stream",
        subscribers: 1,
        success: 1,
        failures: 0,
        latencyMs: expect.any(Number),
      });
    });

    it("should record error metrics when core write fails", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      // Mock core write failure
      mockFetchFromCore.mockResolvedValueOnce(
        new Response("Internal error", { status: 500 }),
      );

      await dobj.publish(PROJECT_ID, "test-stream", {
        payload: new TextEncoder().encode(JSON.stringify({ message: "hello" })).buffer as ArrayBuffer,
        contentType: "application/json",
      });

      expect(mockMetrics.publishError).toHaveBeenCalledWith(
        "test-stream",
        "http_500",
        expect.any(Number),
      );
    });

    it("should handle publish with no subscribers", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      // Mock core write success
      mockFetchFromCore.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await dobj.publish(PROJECT_ID, "test-stream", {
        payload: new TextEncoder().encode(JSON.stringify({ message: "hello" })).buffer as ArrayBuffer,
        contentType: "application/json",
      });

      expect(result.status).toBe(200);
      expect(result.fanoutCount).toBe(0);
      expect(result.fanoutSuccesses).toBe(0);
      expect(result.fanoutFailures).toBe(0);
      expect(result.fanoutMode).toBe("inline");

      // No fanout should have been attempted
      expect(mockFanoutToSubscribers).not.toHaveBeenCalled();
    });

    describe("queued fanout", () => {
      it("should enqueue when above threshold and queue binding exists", async () => {
        const mockSendBatch = vi.fn().mockResolvedValue(undefined);
        const envWithQueue = createMockEnv({
          FANOUT_QUEUE: { sendBatch: mockSendBatch },
          FANOUT_QUEUE_THRESHOLD: "2", // Low threshold for testing
        });

        const sqlStorage = await createTestSqlStorage();
        const state = createMockState(sqlStorage);

        const { SubscriptionDO } = await import("../src/subscriptions/do");
        const dobj = new SubscriptionDO(state as unknown as DurableObjectState, envWithQueue);

        // Add 3 subscribers (above threshold of 2)
        await dobj.addSubscriber("s1");
        await dobj.addSubscriber("s2");
        await dobj.addSubscriber("s3");

        // Mock core write success
        mockFetchFromCore.mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json", "X-Stream-Next-Offset": "10" },
          }),
        );

        const result = await dobj.publish(PROJECT_ID, "test-stream", {
          payload: new TextEncoder().encode("hello").buffer as ArrayBuffer,
          contentType: "text/plain",
        });

        expect(result.fanoutMode).toBe("queued");
        expect(result.fanoutSuccesses).toBe(0); // Not counted for queued
        expect(result.fanoutFailures).toBe(0);
        expect(result.fanoutCount).toBe(3);
        expect(mockSendBatch).toHaveBeenCalled();
        expect(mockFanoutToSubscribers).not.toHaveBeenCalled();
        expect(mockMetrics.fanoutQueued).toHaveBeenCalledWith("test-stream", 3, expect.any(Number));
      });

      it("should use inline when below threshold even with queue binding", async () => {
        const mockSendBatch = vi.fn();
        const envWithQueue = createMockEnv({
          FANOUT_QUEUE: { sendBatch: mockSendBatch },
          FANOUT_QUEUE_THRESHOLD: "10",
        });

        const sqlStorage = await createTestSqlStorage();
        const state = createMockState(sqlStorage);

        const { SubscriptionDO } = await import("../src/subscriptions/do");
        const dobj = new SubscriptionDO(state as unknown as DurableObjectState, envWithQueue);

        await dobj.addSubscriber("s1");
        await dobj.addSubscriber("s2");

        mockFetchFromCore.mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

        mockFanoutToSubscribers.mockResolvedValueOnce({ successes: 2, failures: 0, staleSessionIds: [] });

        const result = await dobj.publish(PROJECT_ID, "test-stream", {
          payload: new TextEncoder().encode("hello").buffer as ArrayBuffer,
          contentType: "text/plain",
        });

        expect(result.fanoutMode).toBe("inline");
        expect(mockSendBatch).not.toHaveBeenCalled();
        expect(mockFanoutToSubscribers).toHaveBeenCalled();
      });

      it("should use inline when no queue binding exists", async () => {
        const { SubscriptionDO } = await import("../src/subscriptions/do");
        const envNoQueue = createMockEnv({ FANOUT_QUEUE_THRESHOLD: "1" });
        const sqlStorage = await createTestSqlStorage();
        const state = createMockState(sqlStorage);
        const dobj = new SubscriptionDO(state as unknown as DurableObjectState, envNoQueue);

        await dobj.addSubscriber("s1");
        await dobj.addSubscriber("s2");

        mockFetchFromCore.mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

        mockFanoutToSubscribers.mockResolvedValueOnce({ successes: 2, failures: 0, staleSessionIds: [] });

        const result = await dobj.publish(PROJECT_ID, "test-stream", {
          payload: new TextEncoder().encode("hello").buffer as ArrayBuffer,
          contentType: "text/plain",
        });

        expect(result.fanoutMode).toBe("inline");
        expect(mockFanoutToSubscribers).toHaveBeenCalled();
      });

      it("should respect env var override for threshold", async () => {
        const mockSendBatch = vi.fn().mockResolvedValue(undefined);
        const envWithQueue = createMockEnv({
          FANOUT_QUEUE: { sendBatch: mockSendBatch },
          FANOUT_QUEUE_THRESHOLD: "1", // Override to 1
        });

        const sqlStorage = await createTestSqlStorage();
        const state = createMockState(sqlStorage);

        const { SubscriptionDO } = await import("../src/subscriptions/do");
        const dobj = new SubscriptionDO(state as unknown as DurableObjectState, envWithQueue);

        await dobj.addSubscriber("s1");
        await dobj.addSubscriber("s2");

        mockFetchFromCore.mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

        const result = await dobj.publish(PROJECT_ID, "test-stream", {
          payload: new TextEncoder().encode("hello").buffer as ArrayBuffer,
          contentType: "text/plain",
        });

        expect(result.fanoutMode).toBe("queued");
        expect(mockSendBatch).toHaveBeenCalled();
      });

      it("should chunk sendBatch calls when messages exceed 100", async () => {
        const mockSendBatch = vi.fn().mockResolvedValue(undefined);
        const envWithQueue = createMockEnv({
          FANOUT_QUEUE: { sendBatch: mockSendBatch },
          FANOUT_QUEUE_THRESHOLD: "0", // Always queue
        });

        const sqlStorage = await createTestSqlStorage();
        const state = createMockState(sqlStorage);

        const { SubscriptionDO } = await import("../src/subscriptions/do");
        const dobj = new SubscriptionDO(state as unknown as DurableObjectState, envWithQueue);

        // Add 6000 subscribers → 120 queue messages (at FANOUT_QUEUE_BATCH_SIZE=50)
        // Should require 2 sendBatch calls (100 + 20)
        for (let i = 0; i < 6000; i++) {
          await dobj.addSubscriber(`s${i}`);
        }

        mockFetchFromCore.mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json", "X-Stream-Next-Offset": "1" },
          }),
        );

        const result = await dobj.publish(PROJECT_ID, "test-stream", {
          payload: new TextEncoder().encode("hello").buffer as ArrayBuffer,
          contentType: "text/plain",
        });

        expect(result.fanoutMode).toBe("queued");
        expect(mockSendBatch).toHaveBeenCalledTimes(2);
        // First call: 100 messages, second call: 20 messages
        expect(mockSendBatch.mock.calls[0][0]).toHaveLength(100);
        expect(mockSendBatch.mock.calls[1][0]).toHaveLength(20);
      });

      it("should fall back to inline when queue enqueue fails", async () => {
        const mockSendBatch = vi.fn().mockRejectedValue(new Error("Queue unavailable"));
        const envWithQueue = createMockEnv({
          FANOUT_QUEUE: { sendBatch: mockSendBatch },
          FANOUT_QUEUE_THRESHOLD: "1",
        });

        const sqlStorage = await createTestSqlStorage();
        const state = createMockState(sqlStorage);

        const { SubscriptionDO } = await import("../src/subscriptions/do");
        const dobj = new SubscriptionDO(state as unknown as DurableObjectState, envWithQueue);

        await dobj.addSubscriber("s1");
        await dobj.addSubscriber("s2");

        mockFetchFromCore.mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

        mockFanoutToSubscribers.mockResolvedValueOnce({ successes: 2, failures: 0, staleSessionIds: [] });

        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const result = await dobj.publish(PROJECT_ID, "test-stream", {
          payload: new TextEncoder().encode("hello").buffer as ArrayBuffer,
          contentType: "text/plain",
        });

        // Should have fallen back to inline
        expect(result.fanoutMode).toBe("inline");
        expect(mockFanoutToSubscribers).toHaveBeenCalled();
        expect(result.fanoutSuccesses).toBe(2);
        expect(consoleErrorSpy).toHaveBeenCalled();

        consoleErrorSpy.mockRestore();
      });
    });
  });
});
