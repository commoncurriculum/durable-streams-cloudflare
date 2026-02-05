import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fetchFromCore
const mockFetchFromCore = vi.fn();
vi.mock("../src/core-client", () => ({
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
      const { SubscriptionDO } = await import("../src/subscription_do");
      new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      expect(mockState.blockConcurrencyWhile).toHaveBeenCalled();
      expect(mockSql.exec).toHaveBeenCalledWith(expect.stringContaining("CREATE TABLE"));
    });
  });

  describe("subscribe endpoint", () => {
    it("should add a subscriber", async () => {
      const { SubscriptionDO } = await import("../src/subscription_do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      const request = new Request("http://do/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stream-Id": "test-stream",
        },
        body: JSON.stringify({ sessionId: "session-123" }),
      });

      const response = await dobj.fetch(request);
      const body = (await response.json()) as { sessionId: string; streamId: string };

      expect(response.status).toBe(200);
      expect(body.sessionId).toBe("session-123");
      expect(body.streamId).toBe("test-stream");
      expect(mockSql._data.has("session-123")).toBe(true);
    });

    it("should return 400 if sessionId is missing", async () => {
      const { SubscriptionDO } = await import("../src/subscription_do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      const request = new Request("http://do/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stream-Id": "test-stream",
        },
        body: JSON.stringify({}),
      });

      const response = await dobj.fetch(request);
      expect(response.status).toBe(400);
    });
  });

  describe("unsubscribe endpoint", () => {
    it("should remove a subscriber", async () => {
      const { SubscriptionDO } = await import("../src/subscription_do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      // First add a subscriber
      mockSql._data.set("session-123", {
        session_id: "session-123",
        subscribed_at: Date.now(),
      });

      const request = new Request("http://do/unsubscribe", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "X-Stream-Id": "test-stream",
        },
        body: JSON.stringify({ sessionId: "session-123" }),
      });

      const response = await dobj.fetch(request);
      const body = (await response.json()) as { unsubscribed: boolean };

      expect(response.status).toBe(200);
      expect(body.unsubscribed).toBe(true);
    });
  });

  describe("subscribers endpoint", () => {
    it("should return all subscribers", async () => {
      const { SubscriptionDO } = await import("../src/subscription_do");
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

      const request = new Request("http://do/subscribers", {
        method: "GET",
        headers: { "X-Stream-Id": "test-stream" },
      });

      const response = await dobj.fetch(request);
      const body = (await response.json()) as { count: number; subscribers: unknown[] };

      expect(response.status).toBe(200);
      expect(body.count).toBe(2);
      expect(body.subscribers).toHaveLength(2);
    });
  });

  describe("404 handling", () => {
    it("should return 404 for unknown paths", async () => {
      const { SubscriptionDO } = await import("../src/subscription_do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      const request = new Request("http://do/unknown", {
        method: "GET",
      });

      const response = await dobj.fetch(request);
      expect(response.status).toBe(404);
    });
  });

  describe("publish endpoint", () => {
    it("should write to core and fanout to subscribers", async () => {
      const { SubscriptionDO } = await import("../src/subscription_do");
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

      const request = new Request("http://do/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stream-Id": "test-stream",
        },
        body: JSON.stringify({ message: "hello" }),
      });

      const response = await dobj.fetch(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("X-Fanout-Count")).toBe("2");
      expect(response.headers.get("X-Fanout-Successes")).toBe("2");
      expect(response.headers.get("X-Fanout-Failures")).toBe("0");

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
      const { SubscriptionDO } = await import("../src/subscription_do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      // Add a subscriber
      mockSql._data.set("session-1", { session_id: "session-1", subscribed_at: 1000 });

      // Mock core write failure
      mockFetchFromCore.mockResolvedValueOnce(
        new Response("Internal error", { status: 500 }),
      );

      const request = new Request("http://do/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stream-Id": "test-stream",
        },
        body: JSON.stringify({ message: "hello" }),
      });

      const response = await dobj.fetch(request);

      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Failed to write to stream");

      // Verify no fanout was attempted
      expect(mockFetchFromCore).toHaveBeenCalledTimes(1);
    });

    it("should forward producer headers to core", async () => {
      const { SubscriptionDO } = await import("../src/subscription_do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      // Mock core write success
      mockFetchFromCore.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const request = new Request("http://do/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stream-Id": "test-stream",
          "Producer-Id": "producer-123",
          "Producer-Epoch": "1",
          "Producer-Seq": "42",
        },
        body: JSON.stringify({ message: "hello" }),
      });

      await dobj.fetch(request);

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
      const { SubscriptionDO } = await import("../src/subscription_do");
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

      const request = new Request("http://do/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stream-Id": "my-stream",
        },
        body: JSON.stringify({ message: "hello" }),
      });

      await dobj.fetch(request);

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
      const { SubscriptionDO } = await import("../src/subscription_do");
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

      const request = new Request("http://do/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stream-Id": "test-stream",
        },
        body: JSON.stringify({ message: "hello" }),
      });

      const response = await dobj.fetch(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("X-Fanout-Successes")).toBe("1");
      expect(response.headers.get("X-Fanout-Failures")).toBe("1");

      // Verify stale subscriber was removed from SQLite
      expect(mockSql._data.has("stale-session")).toBe(false);
      expect(mockSql._data.has("active-session")).toBe(true);
      expect(mockSql._data.size).toBe(1);
    });

    it("should record metrics correctly", async () => {
      const { SubscriptionDO } = await import("../src/subscription_do");
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

      const request = new Request("http://do/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stream-Id": "test-stream",
        },
        body: JSON.stringify({ message: "hello" }),
      });

      await dobj.fetch(request);

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
      const { SubscriptionDO } = await import("../src/subscription_do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      // Mock core write failure
      mockFetchFromCore.mockResolvedValueOnce(
        new Response("Internal error", { status: 500 }),
      );

      const request = new Request("http://do/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stream-Id": "test-stream",
        },
        body: JSON.stringify({ message: "hello" }),
      });

      await dobj.fetch(request);

      expect(mockMetrics.publishError).toHaveBeenCalledWith(
        "test-stream",
        "http_500",
        expect.any(Number),
      );
    });

    it("should handle publish with no subscribers", async () => {
      const { SubscriptionDO } = await import("../src/subscription_do");
      const dobj = new SubscriptionDO(mockState as unknown as DurableObjectState, mockEnv);

      // No subscribers added

      // Mock core write success
      mockFetchFromCore.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const request = new Request("http://do/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stream-Id": "test-stream",
        },
        body: JSON.stringify({ message: "hello" }),
      });

      const response = await dobj.fetch(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("X-Fanout-Count")).toBe("0");
      expect(response.headers.get("X-Fanout-Successes")).toBe("0");
      expect(response.headers.get("X-Fanout-Failures")).toBe("0");

      // Only core write should have been called
      expect(mockFetchFromCore).toHaveBeenCalledTimes(1);
    });
  });
});
