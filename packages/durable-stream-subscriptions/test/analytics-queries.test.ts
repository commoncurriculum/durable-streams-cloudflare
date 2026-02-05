import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getSessionSubscriptions,
  getExpiredSessions,
  getActiveStreamIds,
} from "../src/analytics-queries";

// Mock global fetch
let mockFetch: ReturnType<typeof vi.fn>;

function createMockEnv() {
  return {
    ACCOUNT_ID: "test-account",
    API_TOKEN: "test-token",
  };
}

function createSuccessResponse(data: unknown[]) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data, meta: [], rows: data.length, rows_before_limit_at_least: data.length }),
  };
}

function createErrorResponse(status: number, text: string) {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(text),
  };
}

describe("analytics-queries", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("input validation", () => {
    it("rejects sessionId with SQL injection attempt", async () => {
      const mockEnv = createMockEnv();
      const result = await getSessionSubscriptions(
        mockEnv,
        "valid_dataset",
        "'; DROP TABLE subscribers; --"
      );
      expect(result).toEqual({ data: [], error: "Invalid sessionId format", errorType: "validation" });
    });

    it("rejects sessionId with quotes", async () => {
      const mockEnv = createMockEnv();
      const result = await getSessionSubscriptions(mockEnv, "dataset", "test'id");
      expect(result).toEqual({ data: [], error: "Invalid sessionId format", errorType: "validation" });
    });

    it("rejects sessionId with double quotes", async () => {
      const mockEnv = createMockEnv();
      const result = await getSessionSubscriptions(mockEnv, "dataset", 'test"id');
      expect(result).toEqual({ data: [], error: "Invalid sessionId format", errorType: "validation" });
    });

    it("rejects sessionId with semicolons", async () => {
      const mockEnv = createMockEnv();
      const result = await getSessionSubscriptions(mockEnv, "dataset", "test;id");
      expect(result).toEqual({ data: [], error: "Invalid sessionId format", errorType: "validation" });
    });

    it("rejects sessionId with spaces", async () => {
      const mockEnv = createMockEnv();
      const result = await getSessionSubscriptions(mockEnv, "dataset", "test id");
      expect(result).toEqual({ data: [], error: "Invalid sessionId format", errorType: "validation" });
    });

    it("accepts valid sessionId formats", async () => {
      const mockEnv = createMockEnv();
      mockFetch.mockResolvedValue(createSuccessResponse([]));

      const validIds = ["abc123", "user-123", "session_456", "a:b:c", "User.Session.1"];
      for (const id of validIds) {
        const result = await getSessionSubscriptions(mockEnv, "dataset", id);
        expect(result.error).toBeUndefined();
      }
    });
  });

  describe("getExpiredSessions", () => {
    it("uses argMax for TTL from most recent event, not MAX", async () => {
      const mockEnv = createMockEnv();
      mockFetch.mockResolvedValue(createSuccessResponse([
        {
          sessionId: "test-session",
          ttlSeconds: 1800,
          lastActivity: new Date().toISOString(),
        },
      ]));

      await getExpiredSessions(mockEnv, "dataset");

      // Verify the query uses argMax, not MAX
      expect(mockFetch).toHaveBeenCalled();
      const queryUsed = mockFetch.mock.calls[0][1].body as string;
      expect(queryUsed).toContain("argMax(double3, timestamp)");
      expect(queryUsed).not.toMatch(/MAX\(double3\)/);
    });

    it("returns empty array with error on validation failure", async () => {
      const mockEnv = createMockEnv();
      // This should never happen since lookbackHours is a number,
      // but we test the defensive case
      const result = await getExpiredSessions(mockEnv, "invalid dataset!");
      expect(result.data).toEqual([]);
      expect(result.error).toBeDefined();
    });
  });

  describe("error handling", () => {
    it("returns error info when Analytics Engine fails with 500", async () => {
      const mockEnv = createMockEnv();
      mockFetch.mockResolvedValue(createErrorResponse(500, "Internal error"));

      const result = await getExpiredSessions(mockEnv, "dataset");
      expect(result).toEqual({
        data: [],
        error: "Analytics Engine query failed: 500 - Internal error",
        errorType: "query",
      });
    });

    it("returns error info when network fails", async () => {
      const mockEnv = createMockEnv();
      mockFetch.mockRejectedValue(new Error("Network error"));

      const result = await getExpiredSessions(mockEnv, "dataset");
      expect(result).toEqual({
        data: [],
        error: "Network error",
        errorType: "network",
      });
    });

    it("identifies rate limit errors", async () => {
      const mockEnv = createMockEnv();
      mockFetch.mockResolvedValue(createErrorResponse(429, "Too many requests"));

      const result = await getExpiredSessions(mockEnv, "dataset");
      expect(result.errorType).toBe("rate_limit");
    });

    it("identifies authentication errors", async () => {
      const mockEnv = createMockEnv();
      mockFetch.mockResolvedValue(createErrorResponse(401, "Unauthorized"));

      const result = await getExpiredSessions(mockEnv, "dataset");
      expect(result.errorType).toBe("auth");
    });

    it("returns error for getSessionSubscriptions on API failure", async () => {
      const mockEnv = createMockEnv();
      mockFetch.mockResolvedValue(createErrorResponse(500, "Server error"));

      const result = await getSessionSubscriptions(mockEnv, "dataset", "valid-session");
      expect(result.error).toBe("Analytics Engine query failed: 500 - Server error");
      expect(result.errorType).toBe("query");
    });

    it("returns error for getActiveStreamIds on API failure", async () => {
      const mockEnv = createMockEnv();
      mockFetch.mockResolvedValue(createErrorResponse(503, "Service unavailable"));

      const result = await getActiveStreamIds(mockEnv, "dataset");
      expect(result.error).toBe("Analytics Engine query failed: 503 - Service unavailable");
      expect(result.errorType).toBe("query");
    });
  });

  describe("getSessionSubscriptions", () => {
    it("returns subscriptions on success", async () => {
      const mockEnv = createMockEnv();
      mockFetch.mockResolvedValue(createSuccessResponse([
        { streamId: "stream-1", net: 1 },
        { streamId: "stream-2", net: 2 },
      ]));

      const result = await getSessionSubscriptions(mockEnv, "dataset", "session-123");
      expect(result.data).toEqual([
        { streamId: "stream-1" },
        { streamId: "stream-2" },
      ]);
      expect(result.error).toBeUndefined();
    });
  });

  describe("getActiveStreamIds", () => {
    it("returns stream IDs on success", async () => {
      const mockEnv = createMockEnv();
      mockFetch.mockResolvedValue(createSuccessResponse([
        { streamId: "stream-a" },
        { streamId: "stream-b" },
      ]));

      const result = await getActiveStreamIds(mockEnv, "dataset");
      expect(result.data).toEqual(["stream-a", "stream-b"]);
      expect(result.error).toBeUndefined();
    });

    it("validates lookbackHours is positive", async () => {
      const mockEnv = createMockEnv();
      mockFetch.mockResolvedValue(createSuccessResponse([]));

      // Should use default instead of invalid value
      await getActiveStreamIds(mockEnv, "dataset", -1);
      const queryUsed = mockFetch.mock.calls[0][1].body as string;
      expect(queryUsed).toContain("INTERVAL '24' HOUR");
    });
  });

  describe("dataset name validation", () => {
    it("rejects dataset names with SQL injection", async () => {
      const mockEnv = createMockEnv();

      const result = await getExpiredSessions(mockEnv, "dataset; DROP TABLE --");
      expect(result.error).toBe("Invalid dataset name format");
    });

    it("accepts valid dataset names", async () => {
      const mockEnv = createMockEnv();
      mockFetch.mockResolvedValue(createSuccessResponse([]));

      const validDatasets = ["subscriptions_metrics", "my-dataset", "Dataset123"];
      for (const dataset of validDatasets) {
        const result = await getExpiredSessions(mockEnv, dataset);
        expect(result.error).toBeUndefined();
      }
    });
  });
});
