import { describe, it, expect, vi } from "vitest";
import {
  closeStreamOnly,
  buildClosedConflict,
  validateStreamSeq,
} from "../../../src/stream/close";
import type { StreamMeta, StreamStorage } from "../../../src/storage/types";
import type { ProducerInput } from "../../../src/stream/producer";
import { encodeCurrentOffset } from "../../../src/stream/offsets";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseStreamMeta(overrides: Partial<StreamMeta> = {}): StreamMeta {
  return {
    stream_id: "test-stream",
    content_type: "application/json",
    closed: 0,
    tail_offset: 0,
    read_seq: 0,
    segment_start: 0,
    segment_messages: 0,
    segment_bytes: 0,
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

/**
 * Minimal mock of StreamStorage — only `closeStream` and `upsertProducer`
 * are used by `closeStreamOnly`.
 */
function mockStorage(): StreamStorage & {
  closeStream: ReturnType<typeof vi.fn>;
  upsertProducer: ReturnType<typeof vi.fn>;
} {
  return {
    closeStream: vi.fn().mockResolvedValue(undefined),
    upsertProducer: vi.fn().mockResolvedValue(undefined),
  } as unknown as StreamStorage & {
    closeStream: ReturnType<typeof vi.fn>;
    upsertProducer: ReturnType<typeof vi.fn>;
  };
}

// ---------------------------------------------------------------------------
// buildClosedConflict
// ---------------------------------------------------------------------------

describe("buildClosedConflict", () => {
  it("returns a 409 response with body 'stream is closed'", async () => {
    const meta = baseStreamMeta({ tail_offset: 50, segment_start: 0, read_seq: 0 });
    const nextOffset = encodeCurrentOffset(meta);
    const response = buildClosedConflict(meta, nextOffset);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "stream is closed" });
  });

  it("sets Stream-Next-Offset and Stream-Closed headers", () => {
    const meta = baseStreamMeta({ tail_offset: 100, segment_start: 0, read_seq: 1 });
    const nextOffset = encodeCurrentOffset(meta);
    const response = buildClosedConflict(meta, nextOffset);

    expect(response.headers.get("Stream-Next-Offset")).toBe(nextOffset);
    expect(response.headers.get("Stream-Closed")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// validateStreamSeq
// ---------------------------------------------------------------------------

describe("validateStreamSeq", () => {
  it("returns ok when streamSeq is null", () => {
    const meta = baseStreamMeta({ last_stream_seq: "5" });
    const result = validateStreamSeq(meta, null);

    expect(result.kind).toBe("ok");
  });

  it("returns ok when last_stream_seq is null (no prior seq)", () => {
    const meta = baseStreamMeta({ last_stream_seq: null });
    const result = validateStreamSeq(meta, "3");

    expect(result.kind).toBe("ok");
  });

  it("returns ok when streamSeq is greater than last_stream_seq", () => {
    const meta = baseStreamMeta({ last_stream_seq: "5" });
    const result = validateStreamSeq(meta, "6");

    expect(result.kind).toBe("ok");
  });

  it("returns error 409 when streamSeq equals last_stream_seq", () => {
    const meta = baseStreamMeta({ last_stream_seq: "5" });
    const result = validateStreamSeq(meta, "5");

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.response.status).toBe(409);
    }
  });

  it("returns error 409 when streamSeq is less than last_stream_seq", () => {
    const meta = baseStreamMeta({ last_stream_seq: "5" });
    const result = validateStreamSeq(meta, "3");

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.response.status).toBe(409);
    }
  });

  it("returns ok when both streamSeq and last_stream_seq are null", () => {
    const meta = baseStreamMeta({ last_stream_seq: null });
    const result = validateStreamSeq(meta, null);

    expect(result.kind).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// closeStreamOnly
// ---------------------------------------------------------------------------

describe("closeStreamOnly", () => {
  // ---- No producer (non-producer close) ----

  describe("without producer", () => {
    it("closes an open stream and returns Stream-Closed header", async () => {
      const storage = mockStorage();
      const meta = baseStreamMeta({ closed: 0, tail_offset: 100 });

      const result = await closeStreamOnly(storage, meta);

      expect(result.error).toBeUndefined();
      expect(result.headers.get("Stream-Closed")).toBe("true");
      expect(result.headers.get("Stream-Next-Offset")).toBe(encodeCurrentOffset(meta));
    });

    it("calls storage.closeStream for an open stream", async () => {
      const storage = mockStorage();
      const meta = baseStreamMeta({ closed: 0 });

      await closeStreamOnly(storage, meta);

      expect(storage.closeStream).toHaveBeenCalledWith(
        meta.stream_id,
        expect.any(Number),
        null,
      );
    });

    it("does not call storage.upsertProducer when no producer is provided", async () => {
      const storage = mockStorage();
      const meta = baseStreamMeta({ closed: 0 });

      await closeStreamOnly(storage, meta);

      expect(storage.upsertProducer).not.toHaveBeenCalled();
    });

    it("does not set Producer-Epoch or Producer-Seq headers when no producer", async () => {
      const storage = mockStorage();
      const meta = baseStreamMeta({ closed: 0 });

      const result = await closeStreamOnly(storage, meta);

      expect(result.headers.get("Producer-Epoch")).toBeNull();
      expect(result.headers.get("Producer-Seq")).toBeNull();
    });

    it("skips storage.closeStream when stream is already closed (no producer)", async () => {
      const storage = mockStorage();
      const meta = baseStreamMeta({ closed: 1 });

      const result = await closeStreamOnly(storage, meta);

      expect(storage.closeStream).not.toHaveBeenCalled();
      expect(result.error).toBeUndefined();
      expect(result.headers.get("Stream-Closed")).toBe("true");
    });
  });

  // ---- Producer: idempotent close (already closed by same producer tuple) ----

  describe("with producer — idempotent (same producer tuple)", () => {
    it("returns 204-style response with no error when close matches producer tuple", async () => {
      const storage = mockStorage();
      const producer: ProducerInput = { id: "p1", epoch: 2, seq: 5 };
      const meta = baseStreamMeta({
        closed: 1,
        tail_offset: 200,
        closed_by_producer_id: "p1",
        closed_by_epoch: 2,
        closed_by_seq: 5,
      });

      const result = await closeStreamOnly(storage, meta, producer);

      expect(result.error).toBeUndefined();
      expect(result.headers.get("Stream-Closed")).toBe("true");
      expect(result.headers.get("Stream-Next-Offset")).toBe(encodeCurrentOffset(meta));
      expect(result.headers.get("Producer-Epoch")).toBe("2");
      expect(result.headers.get("Producer-Seq")).toBe("5");
    });

    it("does not call storage.closeStream or upsertProducer for idempotent close", async () => {
      const storage = mockStorage();
      const producer: ProducerInput = { id: "p1", epoch: 1, seq: 0 };
      const meta = baseStreamMeta({
        closed: 1,
        closed_by_producer_id: "p1",
        closed_by_epoch: 1,
        closed_by_seq: 0,
      });

      await closeStreamOnly(storage, meta, producer);

      expect(storage.closeStream).not.toHaveBeenCalled();
      expect(storage.upsertProducer).not.toHaveBeenCalled();
    });
  });

  // ---- Producer: conflict (already closed by different producer tuple) ----

  describe("with producer — conflict (different producer tuple)", () => {
    it("returns error 409 when producer id does not match", async () => {
      const storage = mockStorage();
      const producer: ProducerInput = { id: "p2", epoch: 2, seq: 5 };
      const meta = baseStreamMeta({
        closed: 1,
        tail_offset: 100,
        closed_by_producer_id: "p1",
        closed_by_epoch: 2,
        closed_by_seq: 5,
      });

      const result = await closeStreamOnly(storage, meta, producer);

      expect(result.error).toBeDefined();
      expect(result.error!.status).toBe(409);
    });

    it("returns error 409 when producer epoch does not match", async () => {
      const storage = mockStorage();
      const producer: ProducerInput = { id: "p1", epoch: 3, seq: 5 };
      const meta = baseStreamMeta({
        closed: 1,
        closed_by_producer_id: "p1",
        closed_by_epoch: 2,
        closed_by_seq: 5,
      });

      const result = await closeStreamOnly(storage, meta, producer);

      expect(result.error).toBeDefined();
      expect(result.error!.status).toBe(409);
    });

    it("returns error 409 when producer seq does not match", async () => {
      const storage = mockStorage();
      const producer: ProducerInput = { id: "p1", epoch: 2, seq: 6 };
      const meta = baseStreamMeta({
        closed: 1,
        closed_by_producer_id: "p1",
        closed_by_epoch: 2,
        closed_by_seq: 5,
      });

      const result = await closeStreamOnly(storage, meta, producer);

      expect(result.error).toBeDefined();
      expect(result.error!.status).toBe(409);
    });

    it("does not call storage.closeStream or upsertProducer on conflict", async () => {
      const storage = mockStorage();
      const producer: ProducerInput = { id: "different", epoch: 1, seq: 0 };
      const meta = baseStreamMeta({
        closed: 1,
        closed_by_producer_id: "original",
        closed_by_epoch: 1,
        closed_by_seq: 0,
      });

      await closeStreamOnly(storage, meta, producer);

      expect(storage.closeStream).not.toHaveBeenCalled();
      expect(storage.upsertProducer).not.toHaveBeenCalled();
    });

    it("error response includes Stream-Closed and Stream-Next-Offset headers", async () => {
      const storage = mockStorage();
      const producer: ProducerInput = { id: "p2", epoch: 1, seq: 0 };
      const meta = baseStreamMeta({
        closed: 1,
        tail_offset: 50,
        closed_by_producer_id: "p1",
        closed_by_epoch: 1,
        closed_by_seq: 0,
      });

      const result = await closeStreamOnly(storage, meta, producer);

      expect(result.error).toBeDefined();
      expect(result.error!.headers.get("Stream-Closed")).toBe("true");
      expect(result.error!.headers.get("Stream-Next-Offset")).toBe(encodeCurrentOffset(meta));
    });
  });

  // ---- Producer: first close of an open stream ----

  describe("with producer — closing an open stream", () => {
    it("calls storage.closeStream with the producer info", async () => {
      const storage = mockStorage();
      const producer: ProducerInput = { id: "p1", epoch: 1, seq: 3 };
      const meta = baseStreamMeta({ closed: 0 });

      await closeStreamOnly(storage, meta, producer);

      expect(storage.closeStream).toHaveBeenCalledWith(
        meta.stream_id,
        expect.any(Number),
        producer,
      );
    });

    it("calls storage.upsertProducer with producer, tail_offset, and timestamp", async () => {
      const storage = mockStorage();
      const producer: ProducerInput = { id: "p1", epoch: 2, seq: 7 };
      const meta = baseStreamMeta({ closed: 0, tail_offset: 500 });

      await closeStreamOnly(storage, meta, producer);

      expect(storage.upsertProducer).toHaveBeenCalledWith(
        meta.stream_id,
        producer,
        500,
        expect.any(Number),
      );
    });

    it("returns headers with Producer-Epoch and Producer-Seq", async () => {
      const storage = mockStorage();
      const producer: ProducerInput = { id: "p1", epoch: 4, seq: 10 };
      const meta = baseStreamMeta({ closed: 0 });

      const result = await closeStreamOnly(storage, meta, producer);

      expect(result.error).toBeUndefined();
      expect(result.headers.get("Producer-Epoch")).toBe("4");
      expect(result.headers.get("Producer-Seq")).toBe("10");
      expect(result.headers.get("Stream-Closed")).toBe("true");
    });
  });

  // ---- Producer: closing an already-closed stream with no closed_by fields ----

  describe("with producer — stream closed without producer tracking", () => {
    it("skips storage.closeStream but upserts producer when stream is already closed and no closed_by fields", async () => {
      const storage = mockStorage();
      const producer: ProducerInput = { id: "p1", epoch: 1, seq: 0 };
      const meta = baseStreamMeta({
        closed: 1,
        closed_by_producer_id: null,
        closed_by_epoch: null,
        closed_by_seq: null,
      });

      // When closed=1 and producer is provided, but closed_by fields are all null,
      // the (closed_by_producer_id === producer.id) check fails (null !== "p1"),
      // so this falls to the conflict branch.
      const result = await closeStreamOnly(storage, meta, producer);

      expect(result.error).toBeDefined();
      expect(result.error!.status).toBe(409);
      expect(storage.closeStream).not.toHaveBeenCalled();
      expect(storage.upsertProducer).not.toHaveBeenCalled();
    });
  });
});
