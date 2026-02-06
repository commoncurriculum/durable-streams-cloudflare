import { describe, it, expect, vi } from "vitest";

// Mock D1 database
function createMockDb() {
  const mockFirst = vi.fn().mockResolvedValue(null);
  const mockAll = vi.fn().mockResolvedValue({ results: [] });
  const mockBind = vi.fn().mockReturnThis();

  const mockPrepare = vi.fn().mockReturnValue({
    bind: mockBind,
    first: mockFirst,
    all: mockAll,
  });

  return {
    prepare: mockPrepare,
    _mocks: { mockFirst, mockAll, mockBind, mockPrepare },
  } as unknown as D1Database & {
    _mocks: {
      mockFirst: ReturnType<typeof vi.fn>;
      mockAll: ReturnType<typeof vi.fn>;
      mockBind: ReturnType<typeof vi.fn>;
      mockPrepare: ReturnType<typeof vi.fn>;
    };
  };
}

describe("d1 service", () => {
  describe("listStreams", () => {
    it("should return empty list when no streams exist", async () => {
      const { listStreams } = await import("../src/services/d1");
      const db = createMockDb();
      db._mocks.mockFirst.mockResolvedValue({ count: 0 });
      db._mocks.mockAll.mockResolvedValue({ results: [] });

      const result = await listStreams(db);

      expect(result.streams).toEqual([]);
      expect(result.total).toBe(0);
    });

    it("should return streams when they exist", async () => {
      const { listStreams } = await import("../src/services/d1");
      const db = createMockDb();

      const mockStreams = [
        {
          stream_id: "stream-1",
          content_type: "application/json",
          created_at: 1000,
          deleted_at: null,
        },
      ];

      db._mocks.mockFirst.mockResolvedValue({ count: 1 });
      db._mocks.mockAll.mockResolvedValue({ results: mockStreams });

      const result = await listStreams(db);

      expect(result.streams).toEqual(mockStreams);
      expect(result.total).toBe(1);
    });

    it("should respect limit and offset options", async () => {
      const { listStreams } = await import("../src/services/d1");
      const db = createMockDb();
      db._mocks.mockFirst.mockResolvedValue({ count: 100 });
      db._mocks.mockAll.mockResolvedValue({ results: [] });

      await listStreams(db, { limit: 10, offset: 20 });

      expect(db._mocks.mockBind).toHaveBeenCalledWith(10, 20);
    });
  });

  describe("getStream", () => {
    it("should return null when stream does not exist", async () => {
      const { getStream } = await import("../src/services/d1");
      const db = createMockDb();
      db._mocks.mockFirst.mockResolvedValue(null);

      const result = await getStream(db, "nonexistent");

      expect(result).toBeNull();
    });

    it("should return stream when it exists", async () => {
      const { getStream } = await import("../src/services/d1");
      const db = createMockDb();

      const mockStream = {
        stream_id: "stream-1",
        content_type: "application/json",
        created_at: 1000,
        deleted_at: null,
      };

      db._mocks.mockFirst.mockResolvedValue(mockStream);

      const result = await getStream(db, "stream-1");

      expect(result).toEqual(mockStream);
    });
  });

  describe("getStreamStats", () => {
    it("should return aggregate stats", async () => {
      const { getStreamStats } = await import("../src/services/d1");
      const db = createMockDb();

      db._mocks.mockFirst
        .mockResolvedValueOnce({ total: 10, active: 8, deleted: 2 })
        .mockResolvedValueOnce({ count: 50, size: 1000000 });

      const result = await getStreamStats(db);

      expect(result).toEqual({
        totalStreams: 10,
        activeStreams: 8,
        deletedStreams: 2,
        totalSegments: 50,
        totalSizeBytes: 1000000,
      });
    });
  });
});
