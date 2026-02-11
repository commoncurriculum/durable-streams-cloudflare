import {
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_SEQ,
  normalizeContentType,
} from "../../../shared/headers";
import { parseProducerHeaders } from "../shared/producer";
import type { RawPostInput, ParsedPostInput, Result } from "../types";

function parseContentType(request: Request): string | null {
  return normalizeContentType(request.headers.get("Content-Type"));
}

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
      closeStream: raw.closedHeader?.toLowerCase() === "true",
      contentType: raw.contentTypeHeader,
      streamSeq: raw.streamSeqHeader,
      bodyBytes: raw.bodyBytes,
      producer: raw.producer?.value ?? null,
    },
  };
}
