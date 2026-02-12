import { errorResponse } from "../../../shared/errors";
import {
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_SEQ,
  normalizeContentType,
} from "../../../shared/headers";
import { parseProducerHeaders } from "../shared/producer";
import { appendStream } from "./index";
import type { StreamContext } from "../types";
import type { RawPostInput, ParsedPostInput, Result } from "../types";

/**
 * Parse content-type header with normalization.
 */
function parseContentType(request: Request): string | null {
  return normalizeContentType(request.headers.get("Content-Type"));
}

/**
 * Extract raw data from a POST request.
 * This is a simple data extraction with no validation logic.
 */
async function extractPostInput(
  streamId: string,
  request: Request
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
function parsePostInput(raw: RawPostInput): Result<ParsedPostInput> {
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

/**
 * HTTP handler for POST /streams/{streamId}
 *
 * Parses the HTTP request and calls appendStream (THE ONE function).
 */
export async function appendStreamHttp(
  ctx: StreamContext,
  streamId: string,
  request: Request
): Promise<Response> {
  try {
    // 1. Parse HTTP request
    const raw = await extractPostInput(streamId, request);
    const parsed = parsePostInput(raw);
    if (parsed.kind === "error") return parsed.response;

    const { bodyBytes, producer, closeStream } = parsed.value;

    // 2. Validate Content-Length header matches actual body (HTTP protocol requirement)
    const contentLengthHeader = request.headers.get("Content-Length");
    if (contentLengthHeader !== null) {
      const declaredLength = Number.parseInt(contentLengthHeader, 10);
      if (Number.isNaN(declaredLength) || declaredLength !== bodyBytes.length) {
        return errorResponse(
          400,
          `Content-Length mismatch: header=${contentLengthHeader}, actual=${bodyBytes.length}`
        );
      }
    }

    // 3. Call THE ONE function
    const result = await appendStream(ctx, {
      streamId,
      payload: bodyBytes,
      producer: producer ?? undefined,
      closeStream,
    });

    return new Response(null, {
      status: result.status,
      headers: result.headers,
    });
  } catch (error) {
    return errorResponse(
      500,
      error instanceof Error ? error.message : "Internal error"
    );
  }
}
