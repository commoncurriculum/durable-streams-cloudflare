import { describe, it, expect, vi, beforeEach } from "vitest";

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
});
