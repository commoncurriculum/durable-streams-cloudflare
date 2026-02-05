import {
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_SEQ,
} from "../../protocol/headers";
import { parseProducerHeaders } from "../../engine/producer";
import { parseContentType } from "../../engine/stream";
import type { RawPostInput, ParsedPostInput, Result } from "../types";

/**
 * Extract raw data from a POST request.
 * This is a simple data extraction with no validation logic.
 */
export async function extractPostInput(
  streamId: string,
  request: Request,
): Promise<RawPostInput> {
  const bodyBytes = new Uint8Array(await request.arrayBuffer());

  return {
    streamId,
    closedHeader: request.headers.get(HEADER_STREAM_CLOSED),
    contentTypeHeader: parseContentType(request),
    streamSeqHeader: request.headers.get(HEADER_STREAM_SEQ),
    bodyBytes,
    producer: parseProducerHeaders(request),
  };
}

/**
 * Parse raw POST input into a validated structure.
 * Returns an error result if producer header parsing fails.
 */
export function parsePostInput(raw: RawPostInput): Result<ParsedPostInput> {
  // Check for producer header parse errors
  if (raw.producer?.error) {
    return { kind: "error", response: raw.producer.error };
  }

  return {
    kind: "ok",
    value: {
      streamId: raw.streamId,
      closeStream: raw.closedHeader === "true",
      contentType: raw.contentTypeHeader,
      streamSeq: raw.streamSeqHeader,
      bodyBytes: raw.bodyBytes,
      producer: raw.producer?.value ?? null,
    },
  };
}
