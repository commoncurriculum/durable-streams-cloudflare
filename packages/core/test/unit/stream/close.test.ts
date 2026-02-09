import { describe, it, expect } from "vitest";
import {
  closeStreamOnly,
  buildClosedConflict,
  validateStreamSeq,
} from "../../../src/stream/close";
import type { ProducerInput } from "../../../src/stream/producer";
import { encodeCurrentOffset } from "../../../src/stream/offsets";
import { baseMeta, withStorage, seedStream } from "../helpers";

// close.test uses application/json with zeroed segment fields
function closeBaseMeta(overrides: Partial<Parameters<typeof baseMeta>[0]> = {}) {
  return baseMeta({
    content_type: "application/json",
    tail_offset: 0,
    segment_messages: 0,
    segment_bytes: 0,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// buildClosedConflict
// ---------------------------------------------------------------------------

describe("buildClosedConflict", () => {
  it("returns a 409 response with body 'stream is closed'", async () => {
    const meta = closeBaseMeta({ tail_offset: 50, segment_start: 0, read_seq: 0 });
    const nextOffset = encodeCurrentOffset(meta);
    const response = buildClosedConflict(meta, nextOffset);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "stream is closed" });
  });

  it("sets Stream-Next-Offset and Stream-Closed headers", () => {
    const meta = closeBaseMeta({ tail_offset: 100, segment_start: 0, read_seq: 1 });
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
    const meta = closeBaseMeta({ last_stream_seq: "5" });
    const result = validateStreamSeq(meta, null);

    expect(result.kind).toBe("ok");
  });

  it("returns ok when last_stream_seq is null (no prior seq)", () => {
    const meta = closeBaseMeta({ last_stream_seq: null });
    const result = validateStreamSeq(meta, "3");

    expect(result.kind).toBe("ok");
  });

  it("returns ok when streamSeq is greater than last_stream_seq", () => {
    const meta = closeBaseMeta({ last_stream_seq: "5" });
    const result = validateStreamSeq(meta, "6");

    expect(result.kind).toBe("ok");
  });

  it("returns error 409 when streamSeq equals last_stream_seq", () => {
    const meta = closeBaseMeta({ last_stream_seq: "5" });
    const result = validateStreamSeq(meta, "5");

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.response.status).toBe(409);
    }
  });

  it("returns error 409 when streamSeq is less than last_stream_seq", () => {
    const meta = closeBaseMeta({ last_stream_seq: "5" });
    const result = validateStreamSeq(meta, "3");

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.response.status).toBe(409);
    }
  });

  it("returns ok when both streamSeq and last_stream_seq are null", () => {
    const meta = closeBaseMeta({ last_stream_seq: null });
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
      await withStorage("close-test", async (storage) => {
        const meta = closeBaseMeta({ closed: 0, tail_offset: 100 });
        await seedStream(storage, meta);

        const result = await closeStreamOnly(storage, meta);

        expect(result.error).toBeUndefined();
        expect(result.headers.get("Stream-Closed")).toBe("true");
        expect(result.headers.get("Stream-Next-Offset")).toBe(encodeCurrentOffset(meta));
      });
    });

    it("actually closes the stream in storage", async () => {
      await withStorage("close-test", async (storage) => {
        const meta = closeBaseMeta({ closed: 0 });
        await seedStream(storage, meta);

        await closeStreamOnly(storage, meta);

        const updated = await storage.getStream(meta.stream_id);
        expect(updated?.closed).toBe(1);
        expect(updated?.closed_at).not.toBeNull();
      });
    });

    it("does not upsert a producer when none is provided", async () => {
      await withStorage("close-test", async (storage) => {
        const meta = closeBaseMeta({ closed: 0 });
        await seedStream(storage, meta);

        await closeStreamOnly(storage, meta);

        const producers = await storage.listProducers(meta.stream_id);
        expect(producers).toHaveLength(0);
      });
    });

    it("does not set Producer-Epoch or Producer-Seq headers when no producer", async () => {
      await withStorage("close-test", async (storage) => {
        const meta = closeBaseMeta({ closed: 0 });
        await seedStream(storage, meta);

        const result = await closeStreamOnly(storage, meta);

        expect(result.headers.get("Producer-Epoch")).toBeNull();
        expect(result.headers.get("Producer-Seq")).toBeNull();
      });
    });

    it("skips closing when stream is already closed (no producer)", async () => {
      await withStorage("close-test", async (storage) => {
        const meta = closeBaseMeta({ closed: 1 });
        await seedStream(storage, meta);

        const result = await closeStreamOnly(storage, meta);

        expect(result.error).toBeUndefined();
        expect(result.headers.get("Stream-Closed")).toBe("true");
      });
    });
  });

  // ---- Producer: idempotent close (already closed by same producer tuple) ----

  describe("with producer — idempotent (same producer tuple)", () => {
    it("returns 204-style response with no error when close matches producer tuple", async () => {
      await withStorage("close-test", async (storage) => {
        const producer: ProducerInput = { id: "p1", epoch: 2, seq: 5 };
        const meta = closeBaseMeta({
          closed: 1,
          tail_offset: 200,
          closed_by_producer_id: "p1",
          closed_by_epoch: 2,
          closed_by_seq: 5,
        });
        await seedStream(storage, meta);

        const result = await closeStreamOnly(storage, meta, producer);

        expect(result.error).toBeUndefined();
        expect(result.headers.get("Stream-Closed")).toBe("true");
        expect(result.headers.get("Stream-Next-Offset")).toBe(encodeCurrentOffset(meta));
        expect(result.headers.get("Producer-Epoch")).toBe("2");
        expect(result.headers.get("Producer-Seq")).toBe("5");
      });
    });

    it("does not modify storage for idempotent close", async () => {
      await withStorage("close-test", async (storage) => {
        const producer: ProducerInput = { id: "p1", epoch: 1, seq: 0 };
        const meta = closeBaseMeta({
          closed: 1,
          closed_by_producer_id: "p1",
          closed_by_epoch: 1,
          closed_by_seq: 0,
        });
        await seedStream(storage, meta);

        await closeStreamOnly(storage, meta, producer);

        // No producer should have been upserted
        const producers = await storage.listProducers(meta.stream_id);
        expect(producers).toHaveLength(0);
      });
    });
  });

  // ---- Producer: conflict (already closed by different producer tuple) ----

  describe("with producer — conflict (different producer tuple)", () => {
    it("returns error 409 when producer id does not match", async () => {
      await withStorage("close-test", async (storage) => {
        const producer: ProducerInput = { id: "p2", epoch: 2, seq: 5 };
        const meta = closeBaseMeta({
          closed: 1,
          tail_offset: 100,
          closed_by_producer_id: "p1",
          closed_by_epoch: 2,
          closed_by_seq: 5,
        });
        await seedStream(storage, meta);

        const result = await closeStreamOnly(storage, meta, producer);

        expect(result.error).toBeDefined();
        expect(result.error!.status).toBe(409);
      });
    });

    it("returns error 409 when producer epoch does not match", async () => {
      await withStorage("close-test", async (storage) => {
        const producer: ProducerInput = { id: "p1", epoch: 3, seq: 5 };
        const meta = closeBaseMeta({
          closed: 1,
          closed_by_producer_id: "p1",
          closed_by_epoch: 2,
          closed_by_seq: 5,
        });
        await seedStream(storage, meta);

        const result = await closeStreamOnly(storage, meta, producer);

        expect(result.error).toBeDefined();
        expect(result.error!.status).toBe(409);
      });
    });

    it("returns error 409 when producer seq does not match", async () => {
      await withStorage("close-test", async (storage) => {
        const producer: ProducerInput = { id: "p1", epoch: 2, seq: 6 };
        const meta = closeBaseMeta({
          closed: 1,
          closed_by_producer_id: "p1",
          closed_by_epoch: 2,
          closed_by_seq: 5,
        });
        await seedStream(storage, meta);

        const result = await closeStreamOnly(storage, meta, producer);

        expect(result.error).toBeDefined();
        expect(result.error!.status).toBe(409);
      });
    });

    it("does not modify storage on conflict", async () => {
      await withStorage("close-test", async (storage) => {
        const producer: ProducerInput = { id: "different", epoch: 1, seq: 0 };
        const meta = closeBaseMeta({
          closed: 1,
          closed_by_producer_id: "original",
          closed_by_epoch: 1,
          closed_by_seq: 0,
        });
        await seedStream(storage, meta);

        await closeStreamOnly(storage, meta, producer);

        // No producer should have been upserted
        const producers = await storage.listProducers(meta.stream_id);
        expect(producers).toHaveLength(0);
      });
    });

    it("error response includes Stream-Closed and Stream-Next-Offset headers", async () => {
      await withStorage("close-test", async (storage) => {
        const producer: ProducerInput = { id: "p2", epoch: 1, seq: 0 };
        const meta = closeBaseMeta({
          closed: 1,
          tail_offset: 50,
          closed_by_producer_id: "p1",
          closed_by_epoch: 1,
          closed_by_seq: 0,
        });
        await seedStream(storage, meta);

        const result = await closeStreamOnly(storage, meta, producer);

        expect(result.error).toBeDefined();
        expect(result.error!.headers.get("Stream-Closed")).toBe("true");
        expect(result.error!.headers.get("Stream-Next-Offset")).toBe(encodeCurrentOffset(meta));
      });
    });
  });

  // ---- Producer: first close of an open stream ----

  describe("with producer — closing an open stream", () => {
    it("closes the stream with producer info in storage", async () => {
      await withStorage("close-test", async (storage) => {
        const producer: ProducerInput = { id: "p1", epoch: 1, seq: 3 };
        const meta = closeBaseMeta({ closed: 0 });
        await seedStream(storage, meta);

        await closeStreamOnly(storage, meta, producer);

        const updated = await storage.getStream(meta.stream_id);
        expect(updated?.closed).toBe(1);
        expect(updated?.closed_at).not.toBeNull();
        expect(updated?.closed_by_producer_id).toBe("p1");
        expect(updated?.closed_by_epoch).toBe(1);
        expect(updated?.closed_by_seq).toBe(3);
      });
    });

    it("upserts the producer in storage", async () => {
      await withStorage("close-test", async (storage) => {
        const producer: ProducerInput = { id: "p1", epoch: 2, seq: 7 };
        const meta = closeBaseMeta({ closed: 0, tail_offset: 500 });
        await seedStream(storage, meta);

        await closeStreamOnly(storage, meta, producer);

        const producerState = await storage.getProducer(meta.stream_id, "p1");
        expect(producerState).not.toBeNull();
        expect(producerState!.epoch).toBe(2);
        expect(producerState!.last_seq).toBe(7);
        expect(producerState!.last_offset).toBe(500);
      });
    });

    it("returns headers with Producer-Epoch and Producer-Seq", async () => {
      await withStorage("close-test", async (storage) => {
        const producer: ProducerInput = { id: "p1", epoch: 4, seq: 10 };
        const meta = closeBaseMeta({ closed: 0 });
        await seedStream(storage, meta);

        const result = await closeStreamOnly(storage, meta, producer);

        expect(result.error).toBeUndefined();
        expect(result.headers.get("Producer-Epoch")).toBe("4");
        expect(result.headers.get("Producer-Seq")).toBe("10");
        expect(result.headers.get("Stream-Closed")).toBe("true");
      });
    });
  });

  // ---- Producer: closing an already-closed stream with no closed_by fields ----

  describe("with producer — stream closed without producer tracking", () => {
    it("returns 409 when stream is closed and no closed_by fields", async () => {
      await withStorage("close-test", async (storage) => {
        const producer: ProducerInput = { id: "p1", epoch: 1, seq: 0 };
        const meta = closeBaseMeta({
          closed: 1,
          closed_by_producer_id: null,
          closed_by_epoch: null,
          closed_by_seq: null,
        });
        await seedStream(storage, meta);

        const result = await closeStreamOnly(storage, meta, producer);

        expect(result.error).toBeDefined();
        expect(result.error!.status).toBe(409);

        // No producer should have been upserted
        const producers = await storage.listProducers(meta.stream_id);
        expect(producers).toHaveLength(0);
      });
    });
  });
});
