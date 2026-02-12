import { describe, it, expect } from "vitest";
import { readFromOffset } from "../../../../src/storage/stream-do/read";
import {
  baseMeta,
  withStorage,
  seedStreamFull as seedStream,
  insertOp,
  insertJsonOp,
  decodeBody,
} from "../../helpers";

// ============================================================================
// Binary content reads
// ============================================================================

describe("readFromOffset (binary)", () => {
  it("reads all ops from start", async () => {
    await withStorage("from-offset-test", async (storage) => {
      const meta = baseMeta({ tail_offset: 11 });
      await seedStream(storage, meta);
      await insertOp(storage, 0, "hello");
      await insertOp(storage, 5, " world");

      const result = await readFromOffset(storage, "test-stream", meta, 0, 1024);

      expect(result.hasData).toBe(true);
      expect(decodeBody(result.body)).toBe("hello world");
      expect(result.nextOffset).toBe(11);
      expect(result.upToDate).toBe(true);
    });
  });

  it("reads from mid-stream offset", async () => {
    await withStorage("from-offset-test", async (storage) => {
      const meta = baseMeta({ tail_offset: 11 });
      await seedStream(storage, meta);
      await insertOp(storage, 0, "hello");
      await insertOp(storage, 5, " world");

      const result = await readFromOffset(storage, "test-stream", meta, 5, 1024);

      expect(result.hasData).toBe(true);
      expect(decodeBody(result.body)).toBe(" world");
      expect(result.nextOffset).toBe(11);
    });
  });

  it("handles overlap (offset in middle of a chunk)", async () => {
    await withStorage("from-offset-test", async (storage) => {
      const meta = baseMeta({ tail_offset: 11 });
      await seedStream(storage, meta);
      await insertOp(storage, 0, "hello world");

      const result = await readFromOffset(storage, "test-stream", meta, 5, 1024);

      expect(result.hasData).toBe(true);
      expect(decodeBody(result.body)).toBe(" world");
      expect(result.nextOffset).toBe(11);
    });
  });

  it("returns empty when at tail", async () => {
    await withStorage("from-offset-test", async (storage) => {
      const meta = baseMeta({ tail_offset: 100 });
      await seedStream(storage, meta);

      const result = await readFromOffset(storage, "test-stream", meta, 100, 1024);

      expect(result.hasData).toBe(false);
      expect(result.upToDate).toBe(true);
      expect(result.nextOffset).toBe(100);
    });
  });

  it("respects maxChunkBytes limit", async () => {
    await withStorage("from-offset-test", async (storage) => {
      const meta = baseMeta({ tail_offset: 12 });
      await seedStream(storage, meta);
      await insertOp(storage, 0, "aaaa"); // 4 bytes
      await insertOp(storage, 4, "bbbb"); // 4 bytes
      await insertOp(storage, 8, "cccc"); // 4 bytes

      const result = await readFromOffset(storage, "test-stream", meta, 0, 6);

      expect(result.hasData).toBe(true);
      expect(result.nextOffset).toBe(4);
      expect(decodeBody(result.body)).toBe("aaaa");
    });
  });

  it("sets closedAtTail when stream is closed and at tail", async () => {
    await withStorage("from-offset-test", async (storage) => {
      const meta = baseMeta({ closed: 1, tail_offset: 5 });
      await seedStream(storage, meta);
      await insertOp(storage, 0, "hello");

      const result = await readFromOffset(storage, "test-stream", meta, 0, 1024);

      expect(result.hasData).toBe(true);
      expect(result.closedAtTail).toBe(true);
      expect(result.upToDate).toBe(true);
    });
  });

  it("does not set closedAtTail when not at tail", async () => {
    await withStorage("from-offset-test", async (storage) => {
      const meta = baseMeta({ closed: 1, tail_offset: 20 });
      await seedStream(storage, meta);
      await insertOp(storage, 0, "hello");

      const result = await readFromOffset(storage, "test-stream", meta, 0, 1024);

      expect(result.hasData).toBe(true);
      expect(result.closedAtTail).toBe(false);
      expect(result.upToDate).toBe(false);
    });
  });
});

// ============================================================================
// JSON content reads
// ============================================================================

describe("readFromOffset (JSON)", () => {
  it("reads JSON ops and wraps in array", async () => {
    await withStorage("from-offset-test", async (storage) => {
      const meta = baseMeta({
        content_type: "application/json",
        tail_offset: 2,
      });
      await seedStream(storage, meta);
      await insertJsonOp(storage, 0, { name: "Alice" });
      await insertJsonOp(storage, 1, { name: "Bob" });

      const result = await readFromOffset(storage, "test-stream", meta, 0, 1024);

      expect(result.hasData).toBe(true);
      const parsed = JSON.parse(decodeBody(result.body));
      expect(parsed).toEqual([{ name: "Alice" }, { name: "Bob" }]);
      expect(result.nextOffset).toBe(2);
    });
  });

  it("returns empty JSON array when no data", async () => {
    await withStorage("from-offset-test", async (storage) => {
      const meta = baseMeta({
        content_type: "application/json",
        tail_offset: 5,
      });
      await seedStream(storage, meta);

      const result = await readFromOffset(storage, "test-stream", meta, 5, 1024);

      expect(result.hasData).toBe(false);
      expect(decodeBody(result.body)).toBe("[]");
    });
  });

  it("returns error for offset in middle of JSON message", async () => {
    await withStorage("from-offset-test", async (storage) => {
      const meta = baseMeta({
        content_type: "application/json",
        tail_offset: 2,
      });
      await seedStream(storage, meta);
      // Insert a single wide op: start=0, end=2 (covers offset 1)
      // This simulates a JSON message spanning two "slots"
      await storage.batch([
        storage.insertOpStatement({
          streamId: "test-stream",
          startOffset: 0,
          endOffset: 2,
          sizeBytes: 16,
          streamSeq: null,
          producerId: null,
          producerEpoch: null,
          producerSeq: null,
          body: new TextEncoder().encode('{"name":"Alice"}').buffer as ArrayBuffer,
          createdAt: Date.now(),
        }),
      ]);

      const result = await readFromOffset(storage, "test-stream", meta, 1, 1024);

      // For JSON, when start_offset !== offset in overlap, returns error
      expect(result.hasData).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
