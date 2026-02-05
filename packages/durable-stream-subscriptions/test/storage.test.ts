import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock D1 database
function createMockDb() {
  const mockRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
  const mockFirst = vi.fn().mockResolvedValue(null);
  const mockAll = vi.fn().mockResolvedValue({ results: [] });
  const mockBind = vi.fn().mockReturnThis();

  const mockPrepare = vi.fn().mockReturnValue({
    bind: mockBind,
    run: mockRun,
    first: mockFirst,
    all: mockAll,
  });

  const mockBatch = vi.fn().mockResolvedValue([]);

  return {
    prepare: mockPrepare,
    batch: mockBatch,
    _mocks: { mockRun, mockFirst, mockAll, mockBind, mockPrepare, mockBatch },
  } as unknown as D1Database & {
    _mocks: {
      mockRun: ReturnType<typeof vi.fn>;
      mockFirst: ReturnType<typeof vi.fn>;
      mockAll: ReturnType<typeof vi.fn>;
      mockBind: ReturnType<typeof vi.fn>;
      mockPrepare: ReturnType<typeof vi.fn>;
      mockBatch: ReturnType<typeof vi.fn>;
    };
  };
}

describe("storage", () => {
  describe("createSession", () => {
    it("should insert a new session with correct parameters", async () => {
      const { createSession } = await import("../src/storage");
      const db = createMockDb();

      await createSession(db, "test-session", 1800);

      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO sessions"));
      expect(db._mocks.mockBind).toHaveBeenCalledWith(
        "test-session",
        expect.any(Number),
        expect.any(Number),
        1800,
        expect.any(Number),
      );
    });
  });

  describe("getSession", () => {
    it("should return null when session does not exist", async () => {
      const { getSession } = await import("../src/storage");
      const db = createMockDb();
      db._mocks.mockFirst.mockResolvedValue(null);

      const result = await getSession(db, "nonexistent");

      expect(result).toBeNull();
    });

    it("should return session when it exists", async () => {
      const { getSession } = await import("../src/storage");
      const db = createMockDb();
      const mockSession = {
        session_id: "test-session",
        created_at: 1000,
        last_active_at: 2000,
        ttl_seconds: 1800,
      };
      db._mocks.mockFirst.mockResolvedValue(mockSession);

      const result = await getSession(db, "test-session");

      expect(result).toEqual(mockSession);
    });
  });

  describe("getStreamSubscribers", () => {
    it("should return empty array when no subscribers", async () => {
      const { getStreamSubscribers } = await import("../src/storage");
      const db = createMockDb();
      db._mocks.mockAll.mockResolvedValue({ results: [] });

      const result = await getStreamSubscribers(db, "stream-1");

      expect(result).toEqual([]);
    });

    it("should return session IDs when subscribers exist", async () => {
      const { getStreamSubscribers } = await import("../src/storage");
      const db = createMockDb();
      db._mocks.mockAll.mockResolvedValue({
        results: [{ session_id: "session-1" }, { session_id: "session-2" }],
      });

      const result = await getStreamSubscribers(db, "stream-1");

      expect(result).toEqual(["session-1", "session-2"]);
    });
  });

  describe("addSubscription", () => {
    it("should batch touch session and insert subscription", async () => {
      const { addSubscription } = await import("../src/storage");
      const db = createMockDb();

      await addSubscription(db, "session-1", "stream-1");

      expect(db.batch).toHaveBeenCalled();
    });
  });

  describe("removeSubscription", () => {
    it("should delete subscription", async () => {
      const { removeSubscription } = await import("../src/storage");
      const db = createMockDb();

      await removeSubscription(db, "session-1", "stream-1");

      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM subscriptions"));
    });
  });

  describe("getExpiredSessions", () => {
    it("should query for expired sessions", async () => {
      const { getExpiredSessions } = await import("../src/storage");
      const db = createMockDb();
      db._mocks.mockAll.mockResolvedValue({ results: [] });

      const now = Date.now();
      await getExpiredSessions(db, now);

      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("last_active_at"));
    });
  });

  describe("touchSession", () => {
    it("should update last_active_at", async () => {
      const { touchSession } = await import("../src/storage");
      const db = createMockDb();
      db._mocks.mockRun.mockResolvedValue({ meta: { changes: 1 } });

      const result = await touchSession(db, "test-session");

      expect(result).toBe(true);
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE sessions SET last_active_at"),
      );
    });

    it("should clear marked_for_deletion_at when touching session", async () => {
      const { touchSession } = await import("../src/storage");
      const db = createMockDb();
      db._mocks.mockRun.mockResolvedValue({ meta: { changes: 1 } });

      await touchSession(db, "marked-session");

      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining("marked_for_deletion_at = NULL"),
      );
    });

    it("should return false when session does not exist", async () => {
      const { touchSession } = await import("../src/storage");
      const db = createMockDb();
      db._mocks.mockRun.mockResolvedValue({ meta: { changes: 0 } });

      const result = await touchSession(db, "nonexistent");

      expect(result).toBe(false);
    });
  });

  describe("markExpiredSessions", () => {
    it("should mark only expired sessions without existing mark", async () => {
      const { markExpiredSessions } = await import("../src/storage");
      const db = createMockDb();
      db._mocks.mockRun.mockResolvedValue({ meta: { changes: 5 } });

      const result = await markExpiredSessions(db);

      expect(result.marked).toBe(5);
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining("marked_for_deletion_at IS NULL"),
      );
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining("SET marked_for_deletion_at"),
      );
    });

    it("should return 0 when no sessions need marking", async () => {
      const { markExpiredSessions } = await import("../src/storage");
      const db = createMockDb();
      db._mocks.mockRun.mockResolvedValue({ meta: { changes: 0 } });

      const result = await markExpiredSessions(db);

      expect(result.marked).toBe(0);
    });
  });

  describe("getSessionsToDelete", () => {
    it("should return sessions marked longer than grace period", async () => {
      const { getSessionsToDelete } = await import("../src/storage");
      const db = createMockDb();
      const expiredSession = {
        session_id: "old-session",
        created_at: 1000,
        last_active_at: 2000,
        ttl_seconds: 60,
        marked_for_deletion_at: Date.now() - 120_000, // 2 minutes ago
      };
      db._mocks.mockAll.mockResolvedValue({ results: [expiredSession] });

      const gracePeriodMs = 60_000; // 1 minute
      const result = await getSessionsToDelete(db, gracePeriodMs);

      expect(result).toHaveLength(1);
      expect(result[0].session_id).toBe("old-session");
    });

    it("should exclude sessions touched after marking", async () => {
      const { getSessionsToDelete } = await import("../src/storage");
      const db = createMockDb();
      // Query filters based on TTL expiry, so touched sessions won't match
      db._mocks.mockAll.mockResolvedValue({ results: [] });

      const gracePeriodMs = 60_000;
      const result = await getSessionsToDelete(db, gracePeriodMs);

      expect(result).toHaveLength(0);
      // Verify the query checks both mark time AND TTL expiry
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining("marked_for_deletion_at <"),
      );
      expect(db.prepare).toHaveBeenCalledWith(
        expect.stringContaining("last_active_at + (ttl_seconds * 1000)"),
      );
    });
  });

  describe("getSubscriptionCount", () => {
    it("should return count of subscriptions for a session", async () => {
      const { getSubscriptionCount } = await import("../src/storage");
      const db = createMockDb();
      db._mocks.mockFirst.mockResolvedValue({ count: 5 });

      const result = await getSubscriptionCount(db, "session-1");

      expect(result).toBe(5);
      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("COUNT(*)"));
    });

    it("should return 0 when no subscriptions exist", async () => {
      const { getSubscriptionCount } = await import("../src/storage");
      const db = createMockDb();
      db._mocks.mockFirst.mockResolvedValue(null);

      const result = await getSubscriptionCount(db, "session-1");

      expect(result).toBe(0);
    });
  });
});
