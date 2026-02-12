import { errorResponse, errorToResponse, HttpError } from "../../../shared/errors";
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
 * Body size validation is handled by middleware (bodySizeLimit) before this function is called.
 */
async function extractPostInput(streamId: string, request: Request): Promise<RawPostInput> {
  // Wrap arrayBuffer() to catch platform-level errors (e.g., Cloudflare's own hard limits)
  let bodyBytes: Uint8Array;
  try {
    bodyBytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    // If reading the body fails, treat it as payload too large
    throw new HttpError(413, "payload too large");
  }

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
 * Parses the HTTP request, then calls appendStream inside blockConcurrencyWhile
 * with a try/catch INSIDE the callback so the callback never rejects.
 *
 * This is critical: if blockConcurrencyWhile's callback rejects, workerd marks
 * the DO's input gate as broken, poisoning the entire DO instance.
 * See test/unit/stream/block-concurrency-error.test.ts for proof.
 */
export async function appendStreamHttp(
  ctx: StreamContext,
  streamId: string,
  request: Request,
): Promise<Response> {
  try {
    // 1. Parse HTTP request OUTSIDE blockConcurrencyWhile (no state mutation here)
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
          `Content-Length mismatch: header=${contentLengthHeader}, actual=${bodyBytes.length}`,
        );
      }
    }

    // 3. Call appendStream inside blockConcurrencyWhile with try/catch INSIDE
    return ctx.state.blockConcurrencyWhile(async () => {
      try {
        const result = await appendStream(ctx, {
          streamId,
          payload: bodyBytes,
          contentType: parsed.value.contentType,
          streamSeq: parsed.value.streamSeq,
          producer: producer ?? undefined,
          closeStream,
        });

        return new Response(null, {
          status: result.status,
          headers: result.headers,
        });
      } catch (error) {
        return errorToResponse(error);
      }
    });
  } catch (error) {
    return errorToResponse(error);
  }
}
