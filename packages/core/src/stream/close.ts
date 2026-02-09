import {
  HEADER_PRODUCER_EPOCH,
  HEADER_PRODUCER_SEQ,
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_NEXT_OFFSET,
  baseHeaders,
} from "../protocol/headers";
import { errorResponse } from "../protocol/errors";
import { encodeCurrentOffset } from "./offsets";
import type { Result } from "./types";
import type { StreamMeta, StreamStorage } from "../storage/types";
import type { ProducerInput } from "./producer";

export type CloseOnlyResult = {
  headers: Headers;
  error?: Response;
};

export function buildClosedConflict(meta: StreamMeta, nextOffsetHeader: string): Response {
  const headers = baseHeaders({
    [HEADER_STREAM_NEXT_OFFSET]: nextOffsetHeader,
    [HEADER_STREAM_CLOSED]: "true",
  });
  return Response.json({ error: "stream is closed" }, { status: 409, headers });
}

export function validateStreamSeq(meta: StreamMeta, streamSeq: string | null): Result<null> {
  if (streamSeq && meta.last_stream_seq && streamSeq <= meta.last_stream_seq) {
    return { kind: "error", response: errorResponse(409, "Stream-Seq regression") };
  }
  return { kind: "ok", value: null };
}

export async function closeStreamOnly(
  storage: StreamStorage,
  meta: StreamMeta,
  producer?: ProducerInput,
): Promise<CloseOnlyResult> {
  const nextOffsetHeader = encodeCurrentOffset(meta);

  if (meta.closed === 1 && producer) {
    if (
      meta.closed_by_producer_id === producer.id &&
      meta.closed_by_epoch === producer.epoch &&
      meta.closed_by_seq === producer.seq
    ) {
      const headers = baseHeaders({
        [HEADER_STREAM_NEXT_OFFSET]: nextOffsetHeader,
        [HEADER_STREAM_CLOSED]: "true",
        [HEADER_PRODUCER_EPOCH]: producer.epoch.toString(),
        [HEADER_PRODUCER_SEQ]: producer.seq.toString(),
      });
      return { headers };
    }

    return {
      headers: baseHeaders(),
      error: buildClosedConflict(meta, nextOffsetHeader),
    };
  }

  if (!meta.closed) {
    await storage.closeStream(meta.stream_id, Date.now(), producer ?? null);
  }

  if (producer) {
    await storage.upsertProducer(meta.stream_id, producer, meta.tail_offset, Date.now());
  }

  const headers = baseHeaders({
    [HEADER_STREAM_NEXT_OFFSET]: nextOffsetHeader,
    [HEADER_STREAM_CLOSED]: "true",
  });

  if (producer) {
    headers.set(HEADER_PRODUCER_EPOCH, producer.epoch.toString());
    headers.set(HEADER_PRODUCER_SEQ, producer.seq.toString());
  }

  return { headers };
}
