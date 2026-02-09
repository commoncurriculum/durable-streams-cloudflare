import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { readFromOffset } from "../../../src/stream/read/from_offset";
import { DoSqliteStorage } from "../../../src/storage/queries";
import type { StreamMeta } from "../../../src/storage/types";

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
  const id = env.STREAMS.idFromName(`ts-test-${crypto.randomUUID()}`);
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
  await storage.batch([
    storage.updateStreamStatement(meta.stream_id, [
      "tail_offset = ?",
      "read_seq = ?",
      "segment_start = ?",
    ], [meta.tail_offset, meta.read_seq, meta.segment_start]),
  ]);
}

async function insertOp(
  storage: DoSqliteStorage,
  startOffset: number,
  data: string,
  createdAt: number,
): Promise<void> {
  const body = new TextEncoder().encode(data);
  await storage.batch([
    storage.insertOpStatement({
      streamId: "test-stream",
      startOffset,
      endOffset: startOffset + body.byteLength,
      sizeBytes: body.byteLength,
      streamSeq: null,
      producerId: null,
      producerEpoch: null,
      producerSeq: null,
      body: body.buffer as ArrayBuffer,
      createdAt,
    }),
  ]);
}

describe("readFromOffset writeTimestamp tracking", () => {
  it("single chunk read returns its created_at as writeTimestamp", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({ tail_offset: 5 });
      await seedStream(storage, meta);
      await insertOp(storage, 0, "hello", 1707312000000);

      const result = await readFromOffset(storage, "test-stream", meta, 0, 1024);

      expect(result.hasData).toBe(true);
      expect(result.writeTimestamp).toBe(1707312000000);
    });
  });

  it("multi-chunk read returns the max created_at", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({ tail_offset: 11 });
      await seedStream(storage, meta);
      await insertOp(storage, 0, "hello", 1707312000000);
      await insertOp(storage, 5, " world", 1707312001000);

      const result = await readFromOffset(storage, "test-stream", meta, 0, 1024);

      expect(result.hasData).toBe(true);
      expect(result.writeTimestamp).toBe(1707312001000);
    });
  });

  it("empty read returns writeTimestamp 0", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({ tail_offset: 100 });
      await seedStream(storage, meta);

      const result = await readFromOffset(storage, "test-stream", meta, 100, 1024);

      expect(result.hasData).toBe(false);
      expect(result.writeTimestamp).toBe(0);
    });
  });

  it("overlap chunk contributes its created_at", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({ tail_offset: 11 });
      await seedStream(storage, meta);
      await insertOp(storage, 0, "hello world", 1707312005000);

      // Read from offset 5 (mid-chunk overlap)
      const result = await readFromOffset(storage, "test-stream", meta, 5, 1024);

      expect(result.hasData).toBe(true);
      expect(result.writeTimestamp).toBe(1707312005000);
    });
  });

  it("overlap chunk plus later chunks takes the max", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({ tail_offset: 11 });
      await seedStream(storage, meta);
      await insertOp(storage, 0, "hello", 1707312000000);
      await insertOp(storage, 5, " world", 1707312009000);

      // Overlap read starting at offset 3 (mid first chunk)
      const result = await readFromOffset(storage, "test-stream", meta, 3, 1024);

      expect(result.hasData).toBe(true);
      expect(result.writeTimestamp).toBe(1707312009000);
    });
  });
});
