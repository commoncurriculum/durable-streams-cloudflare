import {
  HEADER_PRODUCER_EPOCH,
  HEADER_PRODUCER_EXPECTED_SEQ,
  HEADER_PRODUCER_ID,
  HEADER_PRODUCER_RECEIVED_SEQ,
  HEADER_PRODUCER_SEQ,
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_NEXT_OFFSET,
  baseHeaders,
} from "../protocol/headers";
import { errorResponse } from "../protocol/errors";
import { encodeOffset } from "../protocol/offsets";
import { isInteger } from "../protocol/validation";
import type { ProducerState, StreamStorage } from "../storage/storage";

export type ProducerInput = {
  id: string;
  epoch: number;
  seq: number;
};

export type ProducerEval =
  | { kind: "none" }
  | { kind: "ok"; state: ProducerState | null }
  | { kind: "duplicate"; state: ProducerState }
  | { kind: "error"; response: Response };

const PRODUCER_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function parseProducerHeaders(
  request: Request,
): { value?: ProducerInput; error?: Response } | null {
  const id = request.headers.get(HEADER_PRODUCER_ID);
  const epochStr = request.headers.get(HEADER_PRODUCER_EPOCH);
  const seqStr = request.headers.get(HEADER_PRODUCER_SEQ);

  const any = id || epochStr || seqStr;
  if (!any) return null;

  if (!id || !epochStr || !seqStr) {
    return { error: errorResponse(400, "Producer headers must be provided together") };
  }

  if (id.trim().length === 0) {
    return { error: errorResponse(400, "Producer-Id must not be empty") };
  }

  if (!isInteger(epochStr) || !isInteger(seqStr)) {
    return { error: errorResponse(400, "Producer-Epoch and Producer-Seq must be integers") };
  }

  return { value: { id, epoch: parseInt(epochStr, 10), seq: parseInt(seqStr, 10) } };
}

export async function evaluateProducer(
  storage: StreamStorage,
  streamId: string,
  producer: ProducerInput,
): Promise<ProducerEval> {
  let existing = await storage.getProducer(streamId, producer.id);
  if (existing?.last_updated) {
    const now = Date.now();
    if (now - existing.last_updated > PRODUCER_STATE_TTL_MS) {
      await storage.deleteProducer(streamId, producer.id);
      existing = null;
    }
  }
  if (!existing) {
    if (producer.seq !== 0) {
      return { kind: "error", response: errorResponse(400, "Producer-Seq must start at 0") };
    }
    return { kind: "ok", state: null };
  }

  if (producer.epoch < existing.epoch) {
    const res = errorResponse(403, "stale producer epoch");
    res.headers.set(HEADER_PRODUCER_EPOCH, existing.epoch.toString());
    return { kind: "error", response: res };
  }

  if (producer.epoch > existing.epoch) {
    if (producer.seq !== 0) {
      return {
        kind: "error",
        response: errorResponse(400, "Producer-Seq must start at 0 for new epoch"),
      };
    }
    return { kind: "ok", state: existing };
  }

  if (producer.seq <= existing.last_seq) {
    return { kind: "duplicate", state: existing };
  }

  if (producer.seq !== existing.last_seq + 1) {
    const res = errorResponse(409, "producer sequence gap");
    res.headers.set(HEADER_PRODUCER_EXPECTED_SEQ, (existing.last_seq + 1).toString());
    res.headers.set(HEADER_PRODUCER_RECEIVED_SEQ, producer.seq.toString());
    return { kind: "error", response: res };
  }

  return { kind: "ok", state: existing };
}

export function producerDuplicateResponse(state: ProducerState, streamClosed: boolean): Response {
  const headers = baseHeaders({
    [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(state.last_offset),
    [HEADER_PRODUCER_EPOCH]: state.epoch.toString(),
    [HEADER_PRODUCER_SEQ]: state.last_seq.toString(),
  });

  if (streamClosed) headers.set(HEADER_STREAM_CLOSED, "true");

  return new Response(null, { status: 204, headers });
}
