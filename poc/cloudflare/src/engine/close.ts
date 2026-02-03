import {
  HEADER_PRODUCER_EPOCH,
  HEADER_PRODUCER_SEQ,
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_NEXT_OFFSET,
  baseHeaders,
} from "../protocol/headers";
import { encodeOffset } from "../protocol/offsets";
import type { StreamMeta, StreamStorage } from "../storage/storage";
import type { ProducerInput } from "./producer";
import { buildClosedConflict } from "./stream";

export type CloseOnlyResult = {
  headers: Headers;
  error?: Response;
};

export async function closeStreamOnly(
  storage: StreamStorage,
  meta: StreamMeta,
  producer?: ProducerInput,
): Promise<CloseOnlyResult> {
  if (meta.closed === 1 && producer) {
    if (
      meta.closed_by_producer_id === producer.id &&
      meta.closed_by_epoch === producer.epoch &&
      meta.closed_by_seq === producer.seq
    ) {
      const headers = baseHeaders({
        [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(meta.tail_offset),
        [HEADER_STREAM_CLOSED]: "true",
        [HEADER_PRODUCER_EPOCH]: producer.epoch.toString(),
        [HEADER_PRODUCER_SEQ]: producer.seq.toString(),
      });
      return { headers };
    }

    return { headers: baseHeaders(), error: buildClosedConflict(meta) };
  }

  if (!meta.closed) {
    await storage.closeStream(meta.stream_id, Date.now(), producer ?? null);
  }

  if (producer) {
    await storage.upsertProducer(meta.stream_id, producer, meta.tail_offset, Date.now());
  }

  const headers = baseHeaders({
    [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(meta.tail_offset),
    [HEADER_STREAM_CLOSED]: "true",
  });

  if (producer) {
    headers.set(HEADER_PRODUCER_EPOCH, producer.epoch.toString());
    headers.set(HEADER_PRODUCER_SEQ, producer.seq.toString());
  }

  return { headers };
}
