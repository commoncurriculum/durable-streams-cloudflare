import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fetchFromCore
const mockFetchFromCore = vi.fn();
vi.mock("../src/client", () => ({
  fetchFromCore: (...args: unknown[]) => mockFetchFromCore(...args),
}));

// Mock metrics
const mockMetrics = {
  publish: vi.fn(),
  publishError: vi.fn(),
  fanout: vi.fn(),
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

// Mock SQL storage for SubscriptionDO
function createMockSqlStorage() {
  const data: Map<string, { session_id: string; subscribed_at: number }> = new Map();

  return {
    exec: vi.fn((query: string, ...args: unknown[]) => {
      if (query.includes("CREATE TABLE")) {
        return { toArray: () => [] };
      }

      if (query.includes("INSERT INTO subscribers")) {
        const [sessionId, subscribedAt] = args as [string, number];
        if (!data.has(sessionId)) {
          data.set(sessionId, { session_id: sessionId, subscribed_at: subscribedAt });
        }
        return { toArray: () => [] };
      }

      if (query.includes("DELETE FROM subscribers")) {
        const [sessionId] = args as [string];
        data.delete(sessionId);
        return { toArray: () => [] };
      }

      if (query.includes("SELECT session_id FROM subscribers")) {
        return {
          [Symbol.iterator]: function* () {
            for (const row of data.values()) {
              yield row;
            }
          },
        };
      }

      if (query.includes("SELECT session_id, subscribed_at FROM subscribers")) {
        return {
          [Symbol.iterator]: function* () {
            for (const row of data.values()) {
              yield row;
            }
          },
        };
      }

      return { toArray: () => [] };
    }),
    _data: data,
  };
}

// Mock DurableObjectState
function createMockState(sqlStorage: ReturnType<typeof createMockSqlStorage>) {
  return {
    storage: {
      sql: sqlStorage,
    },
    blockConcurrencyWhile: vi.fn((fn: () => void) => fn()),
  };
}

// Mock environment
function createMockEnv() {
  return {
    CORE_URL: "http://localhost:8787",
    METRICS: undefined,
  };
}

describe("SubscriptionDO", () => {
  let mockSql: ReturnType<typeof createMockSqlStorage>;
  let mockState: ReturnType<typeof createMockState>;
  let mockEnv: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    mockSql = createMockSqlStorage();
    mockState = createMockState(mockSql);
    mockEnv = createMockEnv();
    vi.clearAllMocks();
    mockFetchFromCore.mockReset();
    mockMetrics.publish.mockClear();
    mockMetrics.publishError.mockClear();
    mockMetrics.fanout.mockClear();
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe("initialization", () => {
    it("should create subscribers table on init", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      expect(mockState.blockConcurrencyWhile).toHaveBeenCalled();
      expect(mockSql.exec).toHaveBeenCalledWith(expect.stringContaining("CREATE TABLE"));
    });
  });

  describe("addSubscriber", () => {
    it("should add a subscriber", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      await dobj.addSubscriber("session-123");

      expect(mockSql._data.has("session-123")).toBe(true);
    });
  });

  describe("removeSubscriber", () => {
    it("should remove a subscriber", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      // First add a subscriber
      mockSql._data.set("session-123", {
        session_id: "session-123",
        subscribed_at: Date.now(),
      });

      await dobj.removeSubscriber("session-123");

      expect(mockSql._data.has("session-123")).toBe(false);
    });
  });

  describe("getSubscribers", () => {
    it("should return all subscribers", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      // Add some subscribers
      mockSql._data.set("session-1", {
        session_id: "session-1",
        subscribed_at: 1000,
      });
      mockSql._data.set("session-2", {
        session_id: "session-2",
        subscribed_at: 2000,
      });

      const result = await dobj.getSubscribers("test-stream");

      expect(result.count).toBe(2);
      expect(result.subscribers).toHaveLength(2);
      expect(result.streamId).toBe("test-stream");
    });
  });

  describe("publish", () => {
    it("should write to core and fanout to subscribers", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      // Add subscribers
      mockSql._data.set("session-1", { session_id: "session-1", subscribed_at: 1000 });
      mockSql._data.set("session-2", { session_id: "session-2", subscribed_at: 2000 });

      // Mock core write success
      mockFetchFromCore.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Stream-Next-Offset": "5" },
        }),
      );

      // Mock fanout writes
      mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 200 }));
      mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const result = await dobj.publish("test-stream", {
        payload: new TextEncoder().encode(JSON.stringify({ message: "hello" })).buffer as ArrayBuffer,
        contentType: "application/json",
      });

      expect(result.status).toBe(200);
      expect(result.fanoutCount).toBe(2);
      expect(result.fanoutSuccesses).toBe(2);
      expect(result.fanoutFailures).toBe(0);

      // Verify core write was called first
      expect(mockFetchFromCore).toHaveBeenNthCalledWith(
        1,
        mockEnv,
        "/v1/stream/test-stream",
        expect.objectContaining({ method: "POST" }),
      );

      // Verify fanout writes were made
      expect(mockFetchFromCore).toHaveBeenCalledTimes(3);
    });

    it("should return error when core write fails", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      // Add a subscriber
      mockSql._data.set("session-1", { session_id: "session-1", subscribed_at: 1000 });

      // Mock core write failure
      mockFetchFromCore.mockResolvedValueOnce(
        new Response("Internal error", { status: 500 }),
      );

      const result = await dobj.publish("test-stream", {
        payload: new TextEncoder().encode(JSON.stringify({ message: "hello" })).buffer as ArrayBuffer,
        contentType: "application/json",
      });

      expect(result.status).toBe(500);
      expect(JSON.parse(result.body).error).toBe("Failed to write to stream");

      // Verify no fanout was attempted
      expect(mockFetchFromCore).toHaveBeenCalledTimes(1);
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

      await dobj.publish("test-stream", {
        payload: new TextEncoder().encode(JSON.stringify({ message: "hello" })).buffer as ArrayBuffer,
        contentType: "application/json",
        producerId: "producer-123",
        producerEpoch: "1",
        producerSeq: "42",
      });

      expect(mockFetchFromCore).toHaveBeenCalledWith(
        mockEnv,
        "/v1/stream/test-stream",
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

      // Add subscriber
      mockSql._data.set("session-1", { session_id: "session-1", subscribed_at: 1000 });

      // Mock core write success with offset
      mockFetchFromCore.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Stream-Next-Offset": "99" },
        }),
      );

      // Mock fanout write
      mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 200 }));

      await dobj.publish("my-stream", {
        payload: new TextEncoder().encode(JSON.stringify({ message: "hello" })).buffer as ArrayBuffer,
        contentType: "application/json",
      });

      // Verify fanout used correct producer headers
      expect(mockFetchFromCore).toHaveBeenNthCalledWith(
        2,
        mockEnv,
        "/v1/stream/session:session-1",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Producer-Id": "fanout:my-stream",
            "Producer-Epoch": "1",
            "Producer-Seq": "99",
          }),
        }),
      );
    });

    it("should remove stale subscriber when fanout returns 404", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      // Add subscribers - one valid, one stale
      mockSql._data.set("active-session", { session_id: "active-session", subscribed_at: 1000 });
      mockSql._data.set("stale-session", { session_id: "stale-session", subscribed_at: 2000 });

      expect(mockSql._data.size).toBe(2);

      // Mock core write success
      mockFetchFromCore.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Stream-Next-Offset": "5" },
        }),
      );

      // Mock fanout: first succeeds, second returns 404
      mockFetchFromCore.mockImplementation((_env: unknown, path: string) => {
        if (path.includes("stale-session")) {
          return Promise.resolve(new Response("Not found", { status: 404 }));
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      });

      const result = await dobj.publish("test-stream", {
        payload: new TextEncoder().encode(JSON.stringify({ message: "hello" })).buffer as ArrayBuffer,
        contentType: "application/json",
      });

      expect(result.status).toBe(200);
      expect(result.fanoutSuccesses).toBe(1);
      expect(result.fanoutFailures).toBe(1);

      // Verify stale subscriber was removed from SQLite
      expect(mockSql._data.has("stale-session")).toBe(false);
      expect(mockSql._data.has("active-session")).toBe(true);
      expect(mockSql._data.size).toBe(1);
    });

    it("should record metrics correctly", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      // Add subscriber
      mockSql._data.set("session-1", { session_id: "session-1", subscribed_at: 1000 });

      // Mock core write success
      mockFetchFromCore.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      // Mock fanout write
      mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 200 }));

      await dobj.publish("test-stream", {
        payload: new TextEncoder().encode(JSON.stringify({ message: "hello" })).buffer as ArrayBuffer,
        contentType: "application/json",
      });

      expect(mockMetrics.publish).toHaveBeenCalledWith(
        "test-stream",
        1, // subscriber count
        expect.any(Number), // latency
      );

      expect(mockMetrics.fanout).toHaveBeenCalledWith(
        "test-stream",
        1, // subscriber count
        1, // successes
        0, // failures
        expect.any(Number), // latency
      );
    });

    it("should record error metrics when core write fails", async () => {
      const { SubscriptionDO } = await import("../src/subscriptions/do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      // Mock core write failure
      mockFetchFromCore.mockResolvedValueOnce(
        new Response("Internal error", { status: 500 }),
      );

      await dobj.publish("test-stream", {
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

      // No subscribers added

      // Mock core write success
      mockFetchFromCore.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await dobj.publish("test-stream", {
        payload: new TextEncoder().encode(JSON.stringify({ message: "hello" })).buffer as ArrayBuffer,
        contentType: "application/json",
      });

      expect(result.status).toBe(200);
      expect(result.fanoutCount).toBe(0);
      expect(result.fanoutSuccesses).toBe(0);
      expect(result.fanoutFailures).toBe(0);

      // Only core write should have been called
      expect(mockFetchFromCore).toHaveBeenCalledTimes(1);
    });
  });
});
