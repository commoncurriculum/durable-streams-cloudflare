import { describe, it, expect } from "vitest";
import {
  encodeCurrentOffset,
  encodeTailOffset,
  encodeStreamOffset,
  resolveOffsetParam,
} from "../../../src/stream/offsets";
import { encodeOffset, decodeOffsetParts } from "../../../src/protocol/offsets";
import type { StreamMeta, StreamStorage, SegmentRecord } from "../../../src/storage/types";

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

function baseSegment(overrides: Partial<SegmentRecord> = {}): SegmentRecord {
  return {
    stream_id: "test-stream",
    r2_key: "stream/test/segment-0.seg",
    start_offset: 0,
    end_offset: 50,
    read_seq: 0,
    content_type: "application/octet-stream",
    created_at: Date.now(),
    expires_at: null,
    size_bytes: 50,
    message_count: 5,
    ...overrides,
  };
}

// Minimal mock storage for offset resolution tests
function mockStorage(opts: {
  segments?: SegmentRecord[];
} = {}): StreamStorage {
  const segments = opts.segments ?? [];

  return {
    getSegmentByReadSeq: async (_streamId: string, readSeq: number) =>
      segments.find((s) => s.read_seq === readSeq) ?? null,
    getSegmentCoveringOffset: async (_streamId: string, offset: number) =>
      segments.find((s) => offset >= s.start_offset && offset < s.end_offset) ?? null,
    getSegmentStartingAt: async (_streamId: string, offset: number) =>
      segments.find((s) => s.start_offset === offset) ?? null,
  } as StreamStorage;
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
    const meta = baseMeta({ tail_offset: 100, segment_start: 0, read_seq: 0 });
    const storage = mockStorage();
    const result = await encodeTailOffset(storage, "test-stream", meta);
    const decoded = decodeOffsetParts(result);

    expect(decoded!.readSeq).toBe(0);
    expect(decoded!.byteOffset).toBe(100);
  });

  it("falls back to previous segment for closed stream with empty current segment", async () => {
    const meta = baseMeta({
      closed: 1,
      tail_offset: 50,
      segment_start: 50,
      read_seq: 1,
    });
    const prevSegment = baseSegment({
      start_offset: 0,
      end_offset: 50,
      read_seq: 0,
    });
    const storage = mockStorage({ segments: [prevSegment] });

    const result = await encodeTailOffset(storage, "test-stream", meta);
    const decoded = decodeOffsetParts(result);

    expect(decoded!.readSeq).toBe(0);
    expect(decoded!.byteOffset).toBe(50); // 50 - 0
  });

  it("uses current segment when no previous segment found", async () => {
    const meta = baseMeta({
      closed: 1,
      tail_offset: 50,
      segment_start: 50,
      read_seq: 1,
    });
    const storage = mockStorage({ segments: [] });

    const result = await encodeTailOffset(storage, "test-stream", meta);
    const decoded = decodeOffsetParts(result);

    // Falls back to current segment encoding
    expect(decoded!.readSeq).toBe(1);
    expect(decoded!.byteOffset).toBe(0); // 50 - 50
  });
});

// ============================================================================
// encodeStreamOffset
// ============================================================================

describe("encodeStreamOffset", () => {
  it("encodes offset in current segment", async () => {
    const meta = baseMeta({ tail_offset: 200, segment_start: 100, read_seq: 2 });
    const storage = mockStorage();

    const result = await encodeStreamOffset(storage, "test-stream", meta, 150);
    const decoded = decodeOffsetParts(result);

    expect(decoded!.readSeq).toBe(2);
    expect(decoded!.byteOffset).toBe(50); // 150 - 100
  });

  it("encodes offset in historical segment", async () => {
    const meta = baseMeta({ tail_offset: 200, segment_start: 100, read_seq: 2 });
    const segment = baseSegment({
      start_offset: 0,
      end_offset: 100,
      read_seq: 0,
    });
    const storage = mockStorage({ segments: [segment] });

    const result = await encodeStreamOffset(storage, "test-stream", meta, 30);
    const decoded = decodeOffsetParts(result);

    expect(decoded!.readSeq).toBe(0);
    expect(decoded!.byteOffset).toBe(30); // 30 - 0
  });

  it("encodes offset at segment boundary using starting segment", async () => {
    const meta = baseMeta({ tail_offset: 200, segment_start: 100, read_seq: 2 });
    const segment = baseSegment({
      start_offset: 50,
      end_offset: 100,
      read_seq: 1,
    });
    const storage = mockStorage({ segments: [segment] });

    const result = await encodeStreamOffset(storage, "test-stream", meta, 50);
    const decoded = decodeOffsetParts(result);

    expect(decoded!.readSeq).toBe(1);
    expect(decoded!.byteOffset).toBe(0); // at start of segment
  });

  it("falls back to current segment read_seq when no segment found", async () => {
    const meta = baseMeta({ tail_offset: 200, segment_start: 100, read_seq: 2 });
    const storage = mockStorage({ segments: [] });

    const result = await encodeStreamOffset(storage, "test-stream", meta, 30);
    const decoded = decodeOffsetParts(result);

    expect(decoded!.readSeq).toBe(2);
    expect(decoded!.byteOffset).toBe(0);
  });
});

// ============================================================================
// resolveOffsetParam
// ============================================================================

describe("resolveOffsetParam", () => {
  it("returns error for null offset", async () => {
    const meta = baseMeta();
    const storage = mockStorage();

    const result = await resolveOffsetParam(storage, "test-stream", meta, null);
    expect(result.error).toBeDefined();
  });

  it("returns error for invalid offset format", async () => {
    const meta = baseMeta();
    const storage = mockStorage();

    const result = await resolveOffsetParam(storage, "test-stream", meta, "garbage");
    expect(result.error).toBeDefined();
  });

  it("resolves offset in current segment", async () => {
    const meta = baseMeta({ tail_offset: 100, segment_start: 0, read_seq: 0 });
    const storage = mockStorage();
    const offsetParam = encodeOffset(50, 0);

    const result = await resolveOffsetParam(storage, "test-stream", meta, offsetParam);
    expect(result.error).toBeUndefined();
    expect(result.offset).toBe(50);
  });

  it("returns error when offset exceeds tail", async () => {
    const meta = baseMeta({ tail_offset: 100, segment_start: 0, read_seq: 0 });
    const storage = mockStorage();
    const offsetParam = encodeOffset(200, 0);

    const result = await resolveOffsetParam(storage, "test-stream", meta, offsetParam);
    expect(result.error).toBeDefined();
  });

  it("returns error when read_seq exceeds current", async () => {
    const meta = baseMeta({ read_seq: 2 });
    const storage = mockStorage();
    const offsetParam = encodeOffset(0, 5);

    const result = await resolveOffsetParam(storage, "test-stream", meta, offsetParam);
    expect(result.error).toBeDefined();
  });

  it("resolves historical segment offset", async () => {
    const meta = baseMeta({ tail_offset: 200, segment_start: 100, read_seq: 1 });
    const segment = baseSegment({
      start_offset: 0,
      end_offset: 100,
      read_seq: 0,
    });
    const storage = mockStorage({ segments: [segment] });
    const offsetParam = encodeOffset(30, 0);

    const result = await resolveOffsetParam(storage, "test-stream", meta, offsetParam);
    expect(result.error).toBeUndefined();
    expect(result.offset).toBe(30); // 0 + 30
  });

  it("returns error when historical offset exceeds segment end", async () => {
    const meta = baseMeta({ tail_offset: 200, segment_start: 100, read_seq: 1 });
    const segment = baseSegment({
      start_offset: 0,
      end_offset: 50,
      read_seq: 0,
    });
    const storage = mockStorage({ segments: [segment] });
    const offsetParam = encodeOffset(60, 0); // 0 + 60 = 60 > 50

    const result = await resolveOffsetParam(storage, "test-stream", meta, offsetParam);
    expect(result.error).toBeDefined();
  });

  it("returns error when historical segment not found", async () => {
    const meta = baseMeta({ tail_offset: 200, segment_start: 100, read_seq: 2 });
    const storage = mockStorage({ segments: [] });
    const offsetParam = encodeOffset(30, 0);

    const result = await resolveOffsetParam(storage, "test-stream", meta, offsetParam);
    expect(result.error).toBeDefined();
  });
});
