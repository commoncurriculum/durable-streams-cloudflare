import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { readFromOffset } from "../../../src/stream/read/from_offset";
import { DoSqliteStorage } from "../../../src/storage/queries";
import type { StreamMeta } from "../../../src/storage/types";

// Helper to create a base StreamMeta
function baseMeta(overrides: Partial<StreamMeta> = {}): StreamMeta {
  return {
    stream_id: "test-stream",
    content_type: "application/octet-stream",
    closed: 0,
    tail_offset: 100,
    read_seq: 0,
    segment_start: 0,
    segment_messages: 10,
    segment_bytes: 100,
    last_stream_seq: null,
    ttl_seconds: null,
    expires_at: null,
    created_at: Date.now(),
    closed_at: null,
    closed_by_producer_id: null,
    closed_by_epoch: null,
    closed_by_seq: null,
    public: 0,
    ...overrides,
  };
}

async function withStorage(fn: (storage: DoSqliteStorage) => Promise<void>): Promise<void> {
  const id = env.STREAMS.idFromName(`from-offset-test-${crypto.randomUUID()}`);
  const stub = env.STREAMS.get(id);
  await runInDurableObject(stub, async (instance) => {
    const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
    const storage = new DoSqliteStorage(sql);
    await fn(storage);
  });
}

async function seedStream(storage: DoSqliteStorage, meta: StreamMeta): Promise<void> {
  await storage.insertStream({
    streamId: meta.stream_id,
    contentType: meta.content_type,
    closed: meta.closed === 1,
    isPublic: meta.public === 1,
    ttlSeconds: meta.ttl_seconds,
    expiresAt: meta.expires_at,
    createdAt: meta.created_at,
  });
  // Update fields that insertStream initializes to 0
  await storage.batch([
    storage.updateStreamStatement(meta.stream_id, [
      "tail_offset = ?",
      "read_seq = ?",
      "segment_start = ?",
      "segment_messages = ?",
      "segment_bytes = ?",
    ], [meta.tail_offset, meta.read_seq, meta.segment_start, meta.segment_messages, meta.segment_bytes]),
  ]);
}

async function insertOp(
  storage: DoSqliteStorage,
  startOffset: number,
  data: string | ArrayBuffer,
  createdAt?: number,
): Promise<void> {
  const body = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const endOffset = startOffset + body.byteLength;
  await storage.batch([
    storage.insertOpStatement({
      streamId: "test-stream",
      startOffset,
      endOffset,
      sizeBytes: body.byteLength,
      streamSeq: null,
      producerId: null,
      producerEpoch: null,
      producerSeq: null,
      body: body.buffer as ArrayBuffer,
      createdAt: createdAt ?? Date.now(),
    }),
  ]);
}

async function insertJsonOp(
  storage: DoSqliteStorage,
  offset: number,
  value: unknown,
): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(value));
  await storage.batch([
    storage.insertOpStatement({
      streamId: "test-stream",
      startOffset: offset,
      endOffset: offset + 1, // JSON offsets are message indices
      sizeBytes: body.byteLength,
      streamSeq: null,
      producerId: null,
      producerEpoch: null,
      producerSeq: null,
      body: body.buffer as ArrayBuffer,
      createdAt: Date.now(),
    }),
  ]);
}

function decodeBody(body: ArrayBuffer): string {
  return new TextDecoder().decode(body);
}

// ============================================================================
// Binary content reads
// ============================================================================

describe("readFromOffset (binary)", () => {
  it("reads all ops from start", async () => {
    await withStorage(async (storage) => {
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
    await withStorage(async (storage) => {
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
    await withStorage(async (storage) => {
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
    await withStorage(async (storage) => {
      const meta = baseMeta({ tail_offset: 100 });
      await seedStream(storage, meta);

      const result = await readFromOffset(storage, "test-stream", meta, 100, 1024);

      expect(result.hasData).toBe(false);
      expect(result.upToDate).toBe(true);
      expect(result.nextOffset).toBe(100);
    });
  });

  it("respects maxChunkBytes limit", async () => {
    await withStorage(async (storage) => {
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
    await withStorage(async (storage) => {
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
    await withStorage(async (storage) => {
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
    await withStorage(async (storage) => {
      const meta = baseMeta({ content_type: "application/json", tail_offset: 2 });
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
    await withStorage(async (storage) => {
      const meta = baseMeta({ content_type: "application/json", tail_offset: 5 });
      await seedStream(storage, meta);

      const result = await readFromOffset(storage, "test-stream", meta, 5, 1024);

      expect(result.hasData).toBe(false);
      expect(decodeBody(result.body)).toBe("[]");
    });
  });

  it("returns error for offset in middle of JSON message", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({ content_type: "application/json", tail_offset: 2 });
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
