import { describe, it, expect } from "vitest";
import { readFromOffset } from "../../../src/stream/read/from_offset";
import type { StreamMeta, StreamStorage, ReadChunk } from "../../../src/storage/types";

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
    ...overrides,
  };
}

// Build a ReadChunk from a string (for binary content)
function binaryChunk(startOffset: number, data: string): ReadChunk {
  const body = new TextEncoder().encode(data);
  return {
    start_offset: startOffset,
    end_offset: startOffset + body.byteLength,
    size_bytes: body.byteLength,
    body,
  };
}

// Build a ReadChunk for JSON content (one message = one JSON value)
function jsonChunk(startOffset: number, value: unknown): ReadChunk {
  const body = new TextEncoder().encode(JSON.stringify(value));
  return {
    start_offset: startOffset,
    end_offset: startOffset + 1, // JSON offsets are message indices
    size_bytes: body.byteLength,
    body,
  };
}

// Mock storage that returns predefined ops
function mockStorage(ops: ReadChunk[]): StreamStorage {
  return {
    selectOverlap: async (_streamId: string, offset: number) => {
      return ops.find((op) => op.start_offset < offset && op.end_offset > offset) ?? null;
    },
    selectOpsFrom: async (_streamId: string, cursor: number) => {
      const result = ops.filter((op) => op.start_offset >= cursor);
      // Simulate batch size of 200
      return result.slice(0, 200);
    },
  } as StreamStorage;
}

// Helper to decode response body as text
function decodeBody(body: ArrayBuffer): string {
  return new TextDecoder().decode(body);
}

// ============================================================================
// Binary content reads
// ============================================================================

describe("readFromOffset (binary)", () => {
  it("reads all ops from start", async () => {
    const ops = [
      binaryChunk(0, "hello"),
      binaryChunk(5, " world"),
    ];
    const meta = baseMeta({ tail_offset: 11 });
    const storage = mockStorage(ops);

    const result = await readFromOffset(storage, "test-stream", meta, 0, 1024);

    expect(result.hasData).toBe(true);
    expect(decodeBody(result.body)).toBe("hello world");
    expect(result.nextOffset).toBe(11);
    expect(result.upToDate).toBe(true);
  });

  it("reads from mid-stream offset", async () => {
    const ops = [
      binaryChunk(0, "hello"),
      binaryChunk(5, " world"),
    ];
    const meta = baseMeta({ tail_offset: 11 });
    const storage = mockStorage(ops);

    const result = await readFromOffset(storage, "test-stream", meta, 5, 1024);

    expect(result.hasData).toBe(true);
    expect(decodeBody(result.body)).toBe(" world");
    expect(result.nextOffset).toBe(11);
  });

  it("handles overlap (offset in middle of a chunk)", async () => {
    const ops = [
      binaryChunk(0, "hello world"),
    ];
    const meta = baseMeta({ tail_offset: 11 });
    const storage = mockStorage(ops);

    const result = await readFromOffset(storage, "test-stream", meta, 5, 1024);

    expect(result.hasData).toBe(true);
    expect(decodeBody(result.body)).toBe(" world");
    expect(result.nextOffset).toBe(11);
  });

  it("returns empty when at tail", async () => {
    const meta = baseMeta({ tail_offset: 100 });
    const storage = mockStorage([]);

    const result = await readFromOffset(storage, "test-stream", meta, 100, 1024);

    expect(result.hasData).toBe(false);
    expect(result.upToDate).toBe(true);
    expect(result.nextOffset).toBe(100);
  });

  it("respects maxChunkBytes limit", async () => {
    const ops = [
      binaryChunk(0, "aaaa"), // 4 bytes
      binaryChunk(4, "bbbb"), // 4 bytes
      binaryChunk(8, "cccc"), // 4 bytes
    ];
    const meta = baseMeta({ tail_offset: 12 });
    const storage = mockStorage(ops);

    const result = await readFromOffset(storage, "test-stream", meta, 0, 6);

    expect(result.hasData).toBe(true);
    // Should get first chunk (4 bytes) + second chunk (4 bytes = 8 total, but 8 > 6 after first)
    // Actually: first chunk 4 bytes, then second 4+4=8 > 6 but 4 > 0 so break
    expect(result.nextOffset).toBe(4);
    expect(decodeBody(result.body)).toBe("aaaa");
  });

  it("sets closedAtTail when stream is closed and at tail", async () => {
    const meta = baseMeta({ closed: 1, tail_offset: 5 });
    const ops = [binaryChunk(0, "hello")];
    const storage = mockStorage(ops);

    const result = await readFromOffset(storage, "test-stream", meta, 0, 1024);

    expect(result.hasData).toBe(true);
    expect(result.closedAtTail).toBe(true);
    expect(result.upToDate).toBe(true);
  });

  it("does not set closedAtTail when not at tail", async () => {
    const meta = baseMeta({ closed: 1, tail_offset: 20 });
    const ops = [binaryChunk(0, "hello")];
    const storage = mockStorage(ops);

    const result = await readFromOffset(storage, "test-stream", meta, 0, 1024);

    expect(result.hasData).toBe(true);
    expect(result.closedAtTail).toBe(false);
    expect(result.upToDate).toBe(false);
  });
});

// ============================================================================
// JSON content reads
// ============================================================================

describe("readFromOffset (JSON)", () => {
  it("reads JSON ops and wraps in array", async () => {
    const ops = [
      jsonChunk(0, { name: "Alice" }),
      jsonChunk(1, { name: "Bob" }),
    ];
    const meta = baseMeta({ content_type: "application/json", tail_offset: 2 });
    const storage = mockStorage(ops);

    const result = await readFromOffset(storage, "test-stream", meta, 0, 1024);

    expect(result.hasData).toBe(true);
    const parsed = JSON.parse(decodeBody(result.body));
    expect(parsed).toEqual([{ name: "Alice" }, { name: "Bob" }]);
    expect(result.nextOffset).toBe(2);
  });

  it("returns empty JSON array when no data", async () => {
    const meta = baseMeta({ content_type: "application/json", tail_offset: 5 });
    const storage = mockStorage([]);

    const result = await readFromOffset(storage, "test-stream", meta, 5, 1024);

    expect(result.hasData).toBe(false);
    expect(decodeBody(result.body)).toBe("[]");
  });

  it("returns error for offset in middle of JSON message", async () => {
    const meta = baseMeta({ content_type: "application/json", tail_offset: 1 });
    // Create a storage where selectOverlap returns a chunk where start_offset !== offset
    const storage = {
      selectOverlap: async () => ({
        start_offset: 0,
        end_offset: 1,
        size_bytes: 10,
        body: new TextEncoder().encode('{"name":"Alice"}'),
      }),
      selectOpsFrom: async () => [],
    } as unknown as StreamStorage;

    const result = await readFromOffset(storage, "test-stream", meta, 1, 1024);

    // For JSON, when start_offset !== offset in overlap, returns error
    // Actually, overlap only returns if start_offset < offset && end_offset > offset
    // But for JSON, offset=1 and start_offset=0 means start_offset !== offset, which is an error
    expect(result.hasData).toBe(false);
    expect(result.error).toBeDefined();
  });
});
