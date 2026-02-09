import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import {
  parseProducerHeaders,
  evaluateProducer,
  type ProducerInput,
} from "../../../src/stream/producer";
import { DoSqliteStorage } from "../../../src/storage/queries";
import type { ProducerState } from "../../../src/storage/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/stream", { headers });
}

function baseProducerState(overrides: Partial<ProducerState> = {}): ProducerState {
  return {
    producer_id: "p1",
    epoch: 1,
    last_seq: 5,
    last_offset: 100,
    last_updated: Date.now(),
    ...overrides,
  };
}

const STREAM_ID = "test-stream";

/**
 * Run test logic inside a fresh Durable Object with real DoSqliteStorage.
 * The DO's schema is already initialized by the constructor.
 */
async function withStorage(fn: (storage: DoSqliteStorage) => Promise<void>): Promise<void> {
  const id = env.STREAMS.idFromName(`producer-test-${crypto.randomUUID()}`);
  const stub = env.STREAMS.get(id);
  await runInDurableObject(stub, async (instance) => {
    const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
    const storage = new DoSqliteStorage(sql);
    await fn(storage);
  });
}

/** Insert a producer record into real storage. */
async function seedProducer(storage: DoSqliteStorage, state: ProducerState): Promise<void> {
  await storage.upsertProducer(
    STREAM_ID,
    { id: state.producer_id, epoch: state.epoch, seq: state.last_seq },
    state.last_offset,
    state.last_updated ?? Date.now(),
  );
}

// ---------------------------------------------------------------------------
// parseProducerHeaders
// ---------------------------------------------------------------------------

describe("parseProducerHeaders", () => {
  it("returns null when no producer headers are present", () => {
    const req = makeRequest();
    const result = parseProducerHeaders(req);

    expect(result).toBeNull();
  });

  it("returns error 400 when only some producer headers are provided", () => {
    const req = makeRequest({ "Producer-Id": "p1" });
    const result = parseProducerHeaders(req);

    expect(result).not.toBeNull();
    expect(result!.error).toBeDefined();
    expect(result!.error!.status).toBe(400);
  });

  it("returns error 400 when Producer-Id and Producer-Epoch are provided but not Producer-Seq", () => {
    const req = makeRequest({ "Producer-Id": "p1", "Producer-Epoch": "1" });
    const result = parseProducerHeaders(req);

    expect(result).not.toBeNull();
    expect(result!.error).toBeDefined();
    expect(result!.error!.status).toBe(400);
  });

  it("returns error 400 for empty Producer-Id", () => {
    const req = makeRequest({
      "Producer-Id": "",
      "Producer-Epoch": "1",
      "Producer-Seq": "0",
    });
    const result = parseProducerHeaders(req);

    expect(result).not.toBeNull();
    expect(result!.error).toBeDefined();
    expect(result!.error!.status).toBe(400);
  });

  it("returns error 400 for whitespace-only Producer-Id", () => {
    const req = makeRequest({
      "Producer-Id": "   ",
      "Producer-Epoch": "1",
      "Producer-Seq": "0",
    });
    const result = parseProducerHeaders(req);

    expect(result).not.toBeNull();
    expect(result!.error).toBeDefined();
    expect(result!.error!.status).toBe(400);
  });

  it("returns error 400 for Producer-Id with disallowed characters", () => {
    const req = makeRequest({
      "Producer-Id": "prod id with spaces",
      "Producer-Epoch": "1",
      "Producer-Seq": "0",
    });
    const result = parseProducerHeaders(req);

    expect(result).not.toBeNull();
    expect(result!.error).toBeDefined();
    expect(result!.error!.status).toBe(400);
  });

  it("returns error 400 for Producer-Id exceeding 256 characters", () => {
    const req = makeRequest({
      "Producer-Id": "a".repeat(257),
      "Producer-Epoch": "1",
      "Producer-Seq": "0",
    });
    const result = parseProducerHeaders(req);

    expect(result).not.toBeNull();
    expect(result!.error).toBeDefined();
    expect(result!.error!.status).toBe(400);
  });

  it("accepts Producer-Id with allowed special characters", () => {
    const req = makeRequest({
      "Producer-Id": "fanout:org-123_stream.v2",
      "Producer-Epoch": "0",
      "Producer-Seq": "0",
    });
    const result = parseProducerHeaders(req);

    expect(result).not.toBeNull();
    expect(result!.error).toBeUndefined();
    expect(result!.value!.id).toBe("fanout:org-123_stream.v2");
  });

  it("accepts Producer-Id at max length (256 chars)", () => {
    const id = "a".repeat(256);
    const req = makeRequest({
      "Producer-Id": id,
      "Producer-Epoch": "0",
      "Producer-Seq": "0",
    });
    const result = parseProducerHeaders(req);

    expect(result).not.toBeNull();
    expect(result!.error).toBeUndefined();
    expect(result!.value!.id).toBe(id);
  });

  it("returns error 400 for non-integer Producer-Epoch", () => {
    const req = makeRequest({
      "Producer-Id": "p1",
      "Producer-Epoch": "abc",
      "Producer-Seq": "0",
    });
    const result = parseProducerHeaders(req);

    expect(result).not.toBeNull();
    expect(result!.error).toBeDefined();
    expect(result!.error!.status).toBe(400);
  });

  it("returns error 400 for non-integer Producer-Seq", () => {
    const req = makeRequest({
      "Producer-Id": "p1",
      "Producer-Epoch": "1",
      "Producer-Seq": "1.5",
    });
    const result = parseProducerHeaders(req);

    expect(result).not.toBeNull();
    expect(result!.error).toBeDefined();
    expect(result!.error!.status).toBe(400);
  });

  it("returns error 400 for negative Producer-Epoch", () => {
    const req = makeRequest({
      "Producer-Id": "p1",
      "Producer-Epoch": "-1",
      "Producer-Seq": "0",
    });
    const result = parseProducerHeaders(req);

    expect(result).not.toBeNull();
    expect(result!.error).toBeDefined();
    expect(result!.error!.status).toBe(400);
  });

  it("returns error 400 when epoch exceeds MAX_SAFE_INTEGER", () => {
    const req = makeRequest({
      "Producer-Id": "p1",
      "Producer-Epoch": "9007199254740992", // 2^53
      "Producer-Seq": "0",
    });
    const result = parseProducerHeaders(req);

    expect(result).not.toBeNull();
    expect(result!.error).toBeDefined();
    expect(result!.error!.status).toBe(400);
  });

  it("returns error 400 when seq exceeds MAX_SAFE_INTEGER", () => {
    const req = makeRequest({
      "Producer-Id": "p1",
      "Producer-Epoch": "1",
      "Producer-Seq": "9007199254740992", // 2^53
    });
    const result = parseProducerHeaders(req);

    expect(result).not.toBeNull();
    expect(result!.error).toBeDefined();
    expect(result!.error!.status).toBe(400);
  });

  it("returns valid ProducerInput for correct headers", () => {
    const req = makeRequest({
      "Producer-Id": "my-producer",
      "Producer-Epoch": "3",
      "Producer-Seq": "42",
    });
    const result = parseProducerHeaders(req);

    expect(result).not.toBeNull();
    expect(result!.error).toBeUndefined();
    expect(result!.value).toEqual({ id: "my-producer", epoch: 3, seq: 42 });
  });

  it("accepts epoch and seq of 0", () => {
    const req = makeRequest({
      "Producer-Id": "p1",
      "Producer-Epoch": "0",
      "Producer-Seq": "0",
    });
    const result = parseProducerHeaders(req);

    expect(result).not.toBeNull();
    expect(result!.error).toBeUndefined();
    expect(result!.value).toEqual({ id: "p1", epoch: 0, seq: 0 });
  });

  it("accepts MAX_SAFE_INTEGER as epoch", () => {
    const req = makeRequest({
      "Producer-Id": "p1",
      "Producer-Epoch": "9007199254740991", // 2^53 - 1
      "Producer-Seq": "0",
    });
    const result = parseProducerHeaders(req);

    expect(result).not.toBeNull();
    expect(result!.error).toBeUndefined();
    expect(result!.value).toEqual({ id: "p1", epoch: 9007199254740991, seq: 0 });
  });
});

// ---------------------------------------------------------------------------
// evaluateProducer
// ---------------------------------------------------------------------------

describe("evaluateProducer", () => {
  it("returns ok with null state when no existing producer and seq=0", async () => {
    await withStorage(async (storage) => {
      const producer: ProducerInput = { id: "p1", epoch: 1, seq: 0 };

      const result = await evaluateProducer(storage, STREAM_ID, producer);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state).toBeNull();
      }
    });
  });

  it("returns error 400 when no existing producer and seq != 0", async () => {
    await withStorage(async (storage) => {
      const producer: ProducerInput = { id: "p1", epoch: 1, seq: 3 };

      const result = await evaluateProducer(storage, STREAM_ID, producer);

      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.response.status).toBe(400);
      }
    });
  });

  it("deletes expired producer and treats as new (seq=0 succeeds)", async () => {
    await withStorage(async (storage) => {
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const expired = baseProducerState({ last_updated: eightDaysAgo });
      await seedProducer(storage, expired);
      const producer: ProducerInput = { id: "p1", epoch: 1, seq: 0 };

      const result = await evaluateProducer(storage, STREAM_ID, producer);

      // Producer should have been deleted
      const remaining = await storage.getProducer(STREAM_ID, "p1");
      expect(remaining).toBeNull();

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state).toBeNull();
      }
    });
  });

  it("deletes expired producer and rejects seq != 0", async () => {
    await withStorage(async (storage) => {
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const expired = baseProducerState({ last_updated: eightDaysAgo });
      await seedProducer(storage, expired);
      const producer: ProducerInput = { id: "p1", epoch: 1, seq: 5 };

      const result = await evaluateProducer(storage, STREAM_ID, producer);

      // Producer should have been deleted
      const remaining = await storage.getProducer(STREAM_ID, "p1");
      expect(remaining).toBeNull();

      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.response.status).toBe(400);
      }
    });
  });

  it("does not treat non-expired producer as expired", async () => {
    await withStorage(async (storage) => {
      const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;
      const existing = baseProducerState({ last_updated: sixDaysAgo, last_seq: 5 });
      await seedProducer(storage, existing);
      const producer: ProducerInput = { id: "p1", epoch: 1, seq: 6 };

      const result = await evaluateProducer(storage, STREAM_ID, producer);

      // Producer should still exist
      const still = await storage.getProducer(STREAM_ID, "p1");
      expect(still).not.toBeNull();

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state).not.toBeNull();
        expect(result.state!.last_seq).toBe(5);
      }
    });
  });

  it("returns error 403 when epoch < existing epoch", async () => {
    await withStorage(async (storage) => {
      const existing = baseProducerState({ epoch: 5 });
      await seedProducer(storage, existing);
      const producer: ProducerInput = { id: "p1", epoch: 3, seq: 0 };

      const result = await evaluateProducer(storage, STREAM_ID, producer);

      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.response.status).toBe(403);
        expect(result.response.headers.get("Producer-Epoch")).toBe("5");
      }
    });
  });

  it("returns ok when epoch > existing epoch and seq=0 (epoch reset)", async () => {
    await withStorage(async (storage) => {
      const existing = baseProducerState({ epoch: 2, last_seq: 10 });
      await seedProducer(storage, existing);
      const producer: ProducerInput = { id: "p1", epoch: 5, seq: 0 };

      const result = await evaluateProducer(storage, STREAM_ID, producer);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state).not.toBeNull();
        expect(result.state!.epoch).toBe(2);
      }
    });
  });

  it("returns error 400 when epoch > existing epoch and seq != 0", async () => {
    await withStorage(async (storage) => {
      const existing = baseProducerState({ epoch: 2, last_seq: 10 });
      await seedProducer(storage, existing);
      const producer: ProducerInput = { id: "p1", epoch: 5, seq: 3 };

      const result = await evaluateProducer(storage, STREAM_ID, producer);

      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.response.status).toBe(400);
      }
    });
  });

  it("returns duplicate when same epoch and seq <= existing last_seq", async () => {
    await withStorage(async (storage) => {
      const existing = baseProducerState({ epoch: 1, last_seq: 5 });
      await seedProducer(storage, existing);
      const producer: ProducerInput = { id: "p1", epoch: 1, seq: 3 };

      const result = await evaluateProducer(storage, STREAM_ID, producer);

      expect(result.kind).toBe("duplicate");
      if (result.kind === "duplicate") {
        expect(result.state.last_seq).toBe(5);
      }
    });
  });

  it("returns duplicate when same epoch and seq equals existing last_seq", async () => {
    await withStorage(async (storage) => {
      const existing = baseProducerState({ epoch: 1, last_seq: 5 });
      await seedProducer(storage, existing);
      const producer: ProducerInput = { id: "p1", epoch: 1, seq: 5 };

      const result = await evaluateProducer(storage, STREAM_ID, producer);

      expect(result.kind).toBe("duplicate");
      if (result.kind === "duplicate") {
        expect(result.state.last_seq).toBe(5);
      }
    });
  });

  it("returns ok when same epoch and seq = last_seq + 1 (next expected)", async () => {
    await withStorage(async (storage) => {
      const existing = baseProducerState({ epoch: 1, last_seq: 5 });
      await seedProducer(storage, existing);
      const producer: ProducerInput = { id: "p1", epoch: 1, seq: 6 };

      const result = await evaluateProducer(storage, STREAM_ID, producer);

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state).not.toBeNull();
        expect(result.state!.last_seq).toBe(5);
      }
    });
  });

  it("returns error 409 with gap headers when same epoch and seq > last_seq + 1", async () => {
    await withStorage(async (storage) => {
      const existing = baseProducerState({ epoch: 1, last_seq: 5 });
      await seedProducer(storage, existing);
      const producer: ProducerInput = { id: "p1", epoch: 1, seq: 10 };

      const result = await evaluateProducer(storage, STREAM_ID, producer);

      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.response.status).toBe(409);
        expect(result.response.headers.get("Producer-Expected-Seq")).toBe("6");
        expect(result.response.headers.get("Producer-Received-Seq")).toBe("10");
      }
    });
  });

  it("handles producer with null last_updated (no expiry check)", async () => {
    await withStorage(async (storage) => {
      const existing = baseProducerState({ last_updated: null, last_seq: 3 });
      await seedProducer(storage, existing);
      const producer: ProducerInput = { id: "p1", epoch: 1, seq: 4 };

      const result = await evaluateProducer(storage, STREAM_ID, producer);

      // Producer should still exist (not deleted)
      const still = await storage.getProducer(STREAM_ID, "p1");
      expect(still).not.toBeNull();

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.state).not.toBeNull();
        expect(result.state!.last_seq).toBe(3);
      }
    });
  });
});
