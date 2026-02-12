import { env, runInDurableObject } from "cloudflare:test";
import { StreamDoStorage } from "../../src/storage/stream-do/queries";
import type { StreamMeta, ProducerState } from "../../src/storage/stream-do/types";

export const STREAM_ID = "test-stream";

export function baseMeta(overrides: Partial<StreamMeta> = {}): StreamMeta {
  return {
    stream_id: STREAM_ID,
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

export function baseProducerState(overrides: Partial<ProducerState> = {}): ProducerState {
  return {
    producer_id: "p1",
    epoch: 1,
    last_seq: 5,
    last_offset: 100,
    last_updated: Date.now(),
    ...overrides,
  };
}

export async function withStorage(
  prefix: string,
  fn: (storage: StreamDoStorage) => Promise<void>,
): Promise<void> {
  const id = env.STREAMS.idFromName(`${prefix}-${crypto.randomUUID()}`);
  const stub = env.STREAMS.get(id);
  await runInDurableObject(stub, async (instance) => {
    const doStorage = (instance as unknown as { ctx: DurableObjectState }).ctx.storage;
    const storage = new StreamDoStorage(doStorage);
    storage.initSchema();
    await fn(storage);
  });
}

/**
 * Insert a stream and optionally update fields that insertStream initializes to 0.
 * Pass `updateFields` to set tail_offset, read_seq, segment_start, etc.
 */
export async function seedStream(
  storage: StreamDoStorage,
  meta: StreamMeta,
  updateFields?: { fields: string[]; values: unknown[] },
): Promise<void> {
  await storage.insertStream({
    streamId: meta.stream_id,
    contentType: meta.content_type,
    closed: meta.closed === 1,
    isPublic: meta.public === 1,
    ttlSeconds: meta.ttl_seconds,
    expiresAt: meta.expires_at,
    createdAt: meta.created_at,
  });
  if (updateFields) {
    await storage.batch([
      storage.updateStreamStatement(meta.stream_id, updateFields.fields, updateFields.values),
    ]);
  }
}

/** Shorthand: seedStream with tail_offset, read_seq, segment_start, segment_messages, segment_bytes. */
export async function seedStreamFull(storage: StreamDoStorage, meta: StreamMeta): Promise<void> {
  await seedStream(storage, meta, {
    fields: [
      "tail_offset = ?",
      "read_seq = ?",
      "segment_start = ?",
      "segment_messages = ?",
      "segment_bytes = ?",
    ],
    values: [
      meta.tail_offset,
      meta.read_seq,
      meta.segment_start,
      meta.segment_messages,
      meta.segment_bytes,
    ],
  });
}

/** Shorthand: seedStream with tail_offset, read_seq, segment_start. */
export async function seedStreamOffsets(storage: StreamDoStorage, meta: StreamMeta): Promise<void> {
  await seedStream(storage, meta, {
    fields: ["tail_offset = ?", "read_seq = ?", "segment_start = ?"],
    values: [meta.tail_offset, meta.read_seq, meta.segment_start],
  });
}

export async function insertOp(
  storage: StreamDoStorage,
  startOffset: number,
  data: string | ArrayBuffer,
  createdAt?: number,
): Promise<void> {
  const body = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const endOffset = startOffset + body.byteLength;
  await storage.batch([
    storage.insertOpStatement({
      streamId: STREAM_ID,
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

export async function insertJsonOp(
  storage: StreamDoStorage,
  offset: number,
  value: unknown,
): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(value));
  await storage.batch([
    storage.insertOpStatement({
      streamId: STREAM_ID,
      startOffset: offset,
      endOffset: offset + 1,
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

export async function insertSegment(
  storage: StreamDoStorage,
  opts: { startOffset: number; endOffset: number; readSeq: number },
): Promise<void> {
  await storage.insertSegment({
    streamId: STREAM_ID,
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

export async function seedProducer(storage: StreamDoStorage, state: ProducerState): Promise<void> {
  await storage.upsertProducer(
    STREAM_ID,
    { id: state.producer_id, epoch: state.epoch, seq: state.last_seq },
    state.last_offset,
    state.last_updated ?? Date.now(),
  );
}

export function decodeBody(body: ArrayBuffer): string {
  return new TextDecoder().decode(body);
}
