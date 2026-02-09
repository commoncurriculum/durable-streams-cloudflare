import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import {
  encodeCurrentOffset,
  encodeTailOffset,
  encodeStreamOffset,
  resolveOffsetParam,
} from "../../../src/stream/offsets";
import { encodeOffset, decodeOffsetParts } from "../../../src/protocol/offsets";
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
  const id = env.STREAMS.idFromName(`offsets-test-${crypto.randomUUID()}`);
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

async function insertSegment(
  storage: DoSqliteStorage,
  opts: { startOffset: number; endOffset: number; readSeq: number },
): Promise<void> {
  await storage.insertSegment({
    streamId: "test-stream",
    r2Key: `stream/test/segment-${opts.readSeq}.seg`,
    startOffset: opts.startOffset,
    endOffset: opts.endOffset,
    readSeq: opts.readSeq,
    contentType: "application/octet-stream",
    createdAt: Date.now(),
    expiresAt: null,
    sizeBytes: opts.endOffset - opts.startOffset,
    messageCount: 5,
  });
}

// ============================================================================
// encodeCurrentOffset
// ============================================================================

describe("encodeCurrentOffset", () => {
  it("encodes offset relative to segment_start with read_seq", () => {
    const meta = baseMeta({ tail_offset: 150, segment_start: 100, read_seq: 2 });
    const result = encodeCurrentOffset(meta);
    const decoded = decodeOffsetParts(result);

    expect(decoded).not.toBeNull();
    expect(decoded!.readSeq).toBe(2);
    expect(decoded!.byteOffset).toBe(50); // 150 - 100
  });

  it("encodes zero offset when tail equals segment_start", () => {
    const meta = baseMeta({ tail_offset: 100, segment_start: 100, read_seq: 3 });
    const result = encodeCurrentOffset(meta);
    const decoded = decodeOffsetParts(result);

    expect(decoded).not.toBeNull();
    expect(decoded!.readSeq).toBe(3);
    expect(decoded!.byteOffset).toBe(0);
  });

  it("matches manual encodeOffset call", () => {
    const meta = baseMeta({ tail_offset: 200, segment_start: 50, read_seq: 1 });
    const expected = encodeOffset(200 - 50, 1);
    expect(encodeCurrentOffset(meta)).toBe(expected);
  });
});

// ============================================================================
// encodeTailOffset
// ============================================================================

describe("encodeTailOffset", () => {
  it("uses current segment for open stream", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({ tail_offset: 100, segment_start: 0, read_seq: 0 });
      await seedStream(storage, meta);

      const result = await encodeTailOffset(storage, "test-stream", meta);
      const decoded = decodeOffsetParts(result);

      expect(decoded!.readSeq).toBe(0);
      expect(decoded!.byteOffset).toBe(100);
    });
  });

  it("falls back to previous segment for closed stream with empty current segment", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({
        closed: 1,
        tail_offset: 50,
        segment_start: 50,
        read_seq: 1,
      });
      await seedStream(storage, meta);
      await insertSegment(storage, { startOffset: 0, endOffset: 50, readSeq: 0 });

      const result = await encodeTailOffset(storage, "test-stream", meta);
      const decoded = decodeOffsetParts(result);

      expect(decoded!.readSeq).toBe(0);
      expect(decoded!.byteOffset).toBe(50); // 50 - 0
    });
  });

  it("uses current segment when no previous segment found", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({
        closed: 1,
        tail_offset: 50,
        segment_start: 50,
        read_seq: 1,
      });
      await seedStream(storage, meta);

      const result = await encodeTailOffset(storage, "test-stream", meta);
      const decoded = decodeOffsetParts(result);

      // Falls back to current segment encoding
      expect(decoded!.readSeq).toBe(1);
      expect(decoded!.byteOffset).toBe(0); // 50 - 50
    });
  });
});

// ============================================================================
// encodeStreamOffset
// ============================================================================

describe("encodeStreamOffset", () => {
  it("encodes offset in current segment", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({ tail_offset: 200, segment_start: 100, read_seq: 2 });
      await seedStream(storage, meta);

      const result = await encodeStreamOffset(storage, "test-stream", meta, 150);
      const decoded = decodeOffsetParts(result);

      expect(decoded!.readSeq).toBe(2);
      expect(decoded!.byteOffset).toBe(50); // 150 - 100
    });
  });

  it("encodes offset in historical segment", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({ tail_offset: 200, segment_start: 100, read_seq: 2 });
      await seedStream(storage, meta);
      await insertSegment(storage, { startOffset: 0, endOffset: 100, readSeq: 0 });

      const result = await encodeStreamOffset(storage, "test-stream", meta, 30);
      const decoded = decodeOffsetParts(result);

      expect(decoded!.readSeq).toBe(0);
      expect(decoded!.byteOffset).toBe(30); // 30 - 0
    });
  });

  it("encodes offset at segment boundary using starting segment", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({ tail_offset: 200, segment_start: 100, read_seq: 2 });
      await seedStream(storage, meta);
      await insertSegment(storage, { startOffset: 50, endOffset: 100, readSeq: 1 });

      const result = await encodeStreamOffset(storage, "test-stream", meta, 50);
      const decoded = decodeOffsetParts(result);

      expect(decoded!.readSeq).toBe(1);
      expect(decoded!.byteOffset).toBe(0); // at start of segment
    });
  });

  it("falls back to current segment read_seq when no segment found", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({ tail_offset: 200, segment_start: 100, read_seq: 2 });
      await seedStream(storage, meta);

      const result = await encodeStreamOffset(storage, "test-stream", meta, 30);
      const decoded = decodeOffsetParts(result);

      expect(decoded!.readSeq).toBe(2);
      expect(decoded!.byteOffset).toBe(0);
    });
  });
});

// ============================================================================
// resolveOffsetParam
// ============================================================================

describe("resolveOffsetParam", () => {
  it("returns error for null offset", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta();
      await seedStream(storage, meta);

      const result = await resolveOffsetParam(storage, "test-stream", meta, null);
      expect(result.error).toBeDefined();
    });
  });

  it("returns error for invalid offset format", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta();
      await seedStream(storage, meta);

      const result = await resolveOffsetParam(storage, "test-stream", meta, "garbage");
      expect(result.error).toBeDefined();
    });
  });

  it("resolves offset in current segment", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({ tail_offset: 100, segment_start: 0, read_seq: 0 });
      await seedStream(storage, meta);
      const offsetParam = encodeOffset(50, 0);

      const result = await resolveOffsetParam(storage, "test-stream", meta, offsetParam);
      expect(result.error).toBeUndefined();
      expect(result.offset).toBe(50);
    });
  });

  it("returns error when offset exceeds tail", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({ tail_offset: 100, segment_start: 0, read_seq: 0 });
      await seedStream(storage, meta);
      const offsetParam = encodeOffset(200, 0);

      const result = await resolveOffsetParam(storage, "test-stream", meta, offsetParam);
      expect(result.error).toBeDefined();
    });
  });

  it("returns error when read_seq exceeds current", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({ read_seq: 2 });
      await seedStream(storage, meta);
      const offsetParam = encodeOffset(0, 5);

      const result = await resolveOffsetParam(storage, "test-stream", meta, offsetParam);
      expect(result.error).toBeDefined();
    });
  });

  it("resolves historical segment offset", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({ tail_offset: 200, segment_start: 100, read_seq: 1 });
      await seedStream(storage, meta);
      await insertSegment(storage, { startOffset: 0, endOffset: 100, readSeq: 0 });
      const offsetParam = encodeOffset(30, 0);

      const result = await resolveOffsetParam(storage, "test-stream", meta, offsetParam);
      expect(result.error).toBeUndefined();
      expect(result.offset).toBe(30); // 0 + 30
    });
  });

  it("returns error when historical offset exceeds segment end", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({ tail_offset: 200, segment_start: 100, read_seq: 1 });
      await seedStream(storage, meta);
      await insertSegment(storage, { startOffset: 0, endOffset: 50, readSeq: 0 });
      const offsetParam = encodeOffset(60, 0); // 0 + 60 = 60 > 50

      const result = await resolveOffsetParam(storage, "test-stream", meta, offsetParam);
      expect(result.error).toBeDefined();
    });
  });

  it("returns error when historical segment not found", async () => {
    await withStorage(async (storage) => {
      const meta = baseMeta({ tail_offset: 200, segment_start: 100, read_seq: 2 });
      await seedStream(storage, meta);
      const offsetParam = encodeOffset(30, 0);

      const result = await resolveOffsetParam(storage, "test-stream", meta, offsetParam);
      expect(result.error).toBeDefined();
    });
  });
});
