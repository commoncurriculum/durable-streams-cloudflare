import { describe, it, expect } from "vitest";
import { readFromOffset } from "../../../src/stream/read/from_offset";
import type { StreamMeta, StreamStorage, ReadChunk } from "../../../src/storage/types";

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

function binaryChunk(startOffset: number, data: string, createdAt: number): ReadChunk {
  const body = new TextEncoder().encode(data);
  return {
    start_offset: startOffset,
    end_offset: startOffset + body.byteLength,
    size_bytes: body.byteLength,
    body,
    created_at: createdAt,
  };
}

function mockStorage(ops: ReadChunk[]): StreamStorage {
  return {
    selectOverlap: async (_streamId: string, offset: number) => {
      return ops.find((op) => op.start_offset < offset && op.end_offset > offset) ?? null;
    },
    selectOpsFrom: async (_streamId: string, cursor: number) => {
      const result = ops.filter((op) => op.start_offset >= cursor);
      return result.slice(0, 200);
    },
  } as StreamStorage;
}

describe("readFromOffset writeTimestamp tracking", () => {
  it("single chunk read returns its created_at as writeTimestamp", async () => {
    const ops = [binaryChunk(0, "hello", 1707312000000)];
    const meta = baseMeta({ tail_offset: 5 });
    const storage = mockStorage(ops);

    const result = await readFromOffset(storage, "test-stream", meta, 0, 1024);

    expect(result.hasData).toBe(true);
    expect(result.writeTimestamp).toBe(1707312000000);
  });

  it("multi-chunk read returns the max created_at", async () => {
    const ops = [
      binaryChunk(0, "hello", 1707312000000),
      binaryChunk(5, " world", 1707312001000),
    ];
    const meta = baseMeta({ tail_offset: 11 });
    const storage = mockStorage(ops);

    const result = await readFromOffset(storage, "test-stream", meta, 0, 1024);

    expect(result.hasData).toBe(true);
    expect(result.writeTimestamp).toBe(1707312001000);
  });

  it("empty read returns writeTimestamp 0", async () => {
    const meta = baseMeta({ tail_offset: 100 });
    const storage = mockStorage([]);

    const result = await readFromOffset(storage, "test-stream", meta, 100, 1024);

    expect(result.hasData).toBe(false);
    expect(result.writeTimestamp).toBe(0);
  });

  it("overlap chunk contributes its created_at", async () => {
    const ops = [
      binaryChunk(0, "hello world", 1707312005000),
    ];
    const meta = baseMeta({ tail_offset: 11 });
    const storage = mockStorage(ops);

    // Read from offset 5 (mid-chunk overlap)
    const result = await readFromOffset(storage, "test-stream", meta, 5, 1024);

    expect(result.hasData).toBe(true);
    expect(result.writeTimestamp).toBe(1707312005000);
  });

  it("overlap chunk plus later chunks takes the max", async () => {
    const ops = [
      binaryChunk(0, "hello", 1707312000000),
      binaryChunk(5, " world", 1707312009000),
    ];
    const meta = baseMeta({ tail_offset: 11 });
    const storage = mockStorage(ops);

    // Overlap read starting at offset 3 (mid first chunk)
    const result = await readFromOffset(storage, "test-stream", meta, 3, 1024);

    expect(result.hasData).toBe(true);
    expect(result.writeTimestamp).toBe(1707312009000);
  });
});
