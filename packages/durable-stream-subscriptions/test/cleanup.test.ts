import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock modules before importing
vi.mock("../src/fanout", async () => {
  return {
    deleteSessionStreamWithEnv: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
  };
});

vi.mock("../src/metrics", () => ({
  createMetrics: vi.fn(() => ({
    sessionExpire: vi.fn(),
    cleanupBatch: vi.fn(),
  })),
}));

// Mock D1 database
function createMockDb() {
  const mockRun = vi.fn().mockResolvedValue({ meta: { changes: 0 } });
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

describe("two-phase cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks expired sessions in phase 1", async () => {
    const { markExpiredSessions } = await import("../src/storage");
    const db = createMockDb();
    db._mocks.mockRun.mockResolvedValue({ meta: { changes: 3 } });

    const result = await markExpiredSessions(db);

    expect(result.marked).toBe(3);
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE sessions"),
    );
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining("marked_for_deletion_at"),
    );
  });

  it("deletes marked sessions after grace period in phase 2", async () => {
    const { getSessionsToDelete } = await import("../src/storage");
    const db = createMockDb();
    const markedSession = {
      session_id: "session-1",
      created_at: Date.now() - 120_000, // 2 minutes ago
      last_active_at: Date.now() - 100_000, // 100 seconds ago
      ttl_seconds: 60, // 1 minute TTL (so expired 40 seconds ago)
      marked_for_deletion_at: Date.now() - 90_000, // marked 90 seconds ago
    };
    db._mocks.mockAll.mockResolvedValue({ results: [markedSession] });

    const gracePeriodMs = 60_000; // 1 minute
    const sessions = await getSessionsToDelete(db, gracePeriodMs);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].session_id).toBe("session-1");
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining("marked_for_deletion_at IS NOT NULL"),
    );
  });

  it("does not delete sessions touched after marking", async () => {
    const { getSessionsToDelete } = await import("../src/storage");
    const db = createMockDb();
    // Return empty - session was touched so no longer meets criteria
    db._mocks.mockAll.mockResolvedValue({ results: [] });

    const gracePeriodMs = 60_000;
    const sessions = await getSessionsToDelete(db, gracePeriodMs);

    expect(sessions).toHaveLength(0);
    // Query includes condition for last_active_at + ttl < now
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining("last_active_at + (ttl_seconds * 1000)"),
    );
  });

  it("tracks deletion metrics for each expired session", async () => {
    const { cleanupExpiredSessions } = await import("../src/cleanup");
    const { createMetrics } = await import("../src/metrics");
    const { deleteSessionStreamWithEnv } = await import("../src/fanout");

    const db = createMockDb();
    const mockMetrics = {
      sessionExpire: vi.fn(),
      cleanupBatch: vi.fn(),
    };
    vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

    // Phase 1: mark returns 0 (already marked)
    db._mocks.mockRun.mockResolvedValueOnce({ meta: { changes: 0 } });

    // Phase 2: sessions to delete
    const sessionsToDelete = [
      {
        session_id: "session-1",
        created_at: Date.now() - 120_000,
        last_active_at: Date.now() - 100_000,
        ttl_seconds: 60,
        marked_for_deletion_at: Date.now() - 90_000,
      },
      {
        session_id: "session-2",
        created_at: Date.now() - 180_000,
        last_active_at: Date.now() - 150_000,
        ttl_seconds: 60,
        marked_for_deletion_at: Date.now() - 120_000,
      },
    ];
    db._mocks.mockAll.mockResolvedValueOnce({ results: sessionsToDelete });

    // Subscription counts
    db._mocks.mockFirst
      .mockResolvedValueOnce({ count: 2 }) // session-1 has 2 subs
      .mockResolvedValueOnce({ count: 3 }); // session-2 has 3 subs

    // Mock the deleteSessionStreamWithEnv to return success
    vi.mocked(deleteSessionStreamWithEnv).mockResolvedValue({ ok: true, status: 200 } as Response);

    const env = {
      DB: db,
      CORE_URL: "http://localhost:8787",
      METRICS: undefined,
    };

    await cleanupExpiredSessions(env as any);

    // Verify sessionExpire was called for each session
    expect(mockMetrics.sessionExpire).toHaveBeenCalledTimes(2);
    expect(mockMetrics.sessionExpire).toHaveBeenCalledWith(
      "session-1",
      2, // subscription count
      expect.any(Number), // age in ms
    );
    expect(mockMetrics.sessionExpire).toHaveBeenCalledWith(
      "session-2",
      3, // subscription count
      expect.any(Number), // age in ms
    );
  });
});

describe("cleanupExpiredSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns early when no sessions are marked for deletion", async () => {
    const { cleanupExpiredSessions } = await import("../src/cleanup");
    const { deleteSessionStreamWithEnv } = await import("../src/fanout");
    const { createMetrics } = await import("../src/metrics");

    const mockMetrics = {
      sessionExpire: vi.fn(),
      cleanupBatch: vi.fn(),
    };
    vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

    const db = createMockDb();
    db._mocks.mockRun.mockResolvedValue({ meta: { changes: 2 } }); // 2 marked
    db._mocks.mockAll.mockResolvedValue({ results: [] }); // 0 to delete

    const env = {
      DB: db,
      CORE_URL: "http://localhost:8787",
      METRICS: undefined,
    };

    const result = await cleanupExpiredSessions(env as any);

    expect(result.marked).toBe(2);
    expect(result.deleted).toBe(0);
    expect(result.streamDeleteSuccesses).toBe(0);
    expect(result.streamDeleteFailures).toBe(0);
    expect(deleteSessionStreamWithEnv).not.toHaveBeenCalled();
    // Verify cleanupBatch metric is recorded even when nothing to delete
    expect(mockMetrics.cleanupBatch).toHaveBeenCalledWith(2, 0, 0, 0, expect.any(Number));
  });

  it("counts successful and failed stream deletions", async () => {
    const { cleanupExpiredSessions } = await import("../src/cleanup");
    const { deleteSessionStreamWithEnv } = await import("../src/fanout");
    const { createMetrics } = await import("../src/metrics");

    const mockMetrics = {
      sessionExpire: vi.fn(),
      cleanupBatch: vi.fn(),
    };
    vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

    const db = createMockDb();
    db._mocks.mockRun.mockResolvedValue({ meta: { changes: 0 } });
    db._mocks.mockAll.mockResolvedValue({
      results: [
        { session_id: "success-1", created_at: 1000, last_active_at: 1000, ttl_seconds: 1, marked_for_deletion_at: 1 },
        { session_id: "success-2", created_at: 1000, last_active_at: 1000, ttl_seconds: 1, marked_for_deletion_at: 1 },
        { session_id: "fail-1", created_at: 1000, last_active_at: 1000, ttl_seconds: 1, marked_for_deletion_at: 1 },
      ],
    });
    db._mocks.mockFirst.mockResolvedValue({ count: 0 }); // No subscriptions

    vi.mocked(deleteSessionStreamWithEnv)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 404 } as Response) // 404 counts as success
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response);

    const env = {
      DB: db,
      CORE_URL: "http://localhost:8787",
      METRICS: undefined,
    };

    const result = await cleanupExpiredSessions(env as any);

    expect(result.deleted).toBe(3);
    expect(result.streamDeleteSuccesses).toBe(2); // 200 and 404
    expect(result.streamDeleteFailures).toBe(1); // 500
    // Verify cleanupBatch metric is recorded with correct values
    expect(mockMetrics.cleanupBatch).toHaveBeenCalledWith(0, 3, 2, 1, expect.any(Number));
  });
});
