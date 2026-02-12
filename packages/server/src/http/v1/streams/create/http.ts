import { errorResponse } from "../../../shared/errors";
import {
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_EXPIRES_AT,
  HEADER_STREAM_SEQ,
  HEADER_STREAM_TTL,
  normalizeContentType,
} from "../../../shared/headers";
import { parseProducerHeaders } from "../shared/producer";
import { createStream } from "./index";
import type { StreamContext } from "../types";

/**
 * HTTP handler for PUT /streams/{streamId}
 *
 * Parses the HTTP request and calls createStream (THE ONE function).
 */
export async function createStreamHttp(
  ctx: StreamContext,
  streamId: string,
  request: Request
): Promise<Response> {
  return ctx.state.blockConcurrencyWhile(async () => {
    try {
      const url = new URL(request.url);
      const bodyBytes = new Uint8Array(await request.arrayBuffer());

      // 1. Validate Content-Length header matches actual body (HTTP protocol requirement)
      const contentLengthHeader = request.headers.get("Content-Length");
      if (contentLengthHeader !== null) {
        const declaredLength = Number.parseInt(contentLengthHeader, 10);
        if (
          Number.isNaN(declaredLength) ||
          declaredLength !== bodyBytes.length
        ) {
          return errorResponse(
            400,
            `Content-Length mismatch: header=${contentLengthHeader}, actual=${bodyBytes.length}`
          );
        }
      }

      // 2. Parse producer headers (can fail with HTTP error response)
      const producerResult = parseProducerHeaders(request);
      if (producerResult?.error) {
        return producerResult.error;
      }

      // 3. Call THE ONE function with all parsed HTTP data
      const result = await createStream(ctx, {
        streamId,
        contentType: normalizeContentType(request.headers.get("Content-Type")),
        payload: bodyBytes,
        streamSeq: request.headers.get(HEADER_STREAM_SEQ),
        producer: producerResult?.value ?? null,
        closeStream:
          request.headers.get(HEADER_STREAM_CLOSED)?.toLowerCase() === "true",
        isPublic: url.searchParams.get("public") === "true",
        ttlHeader: request.headers.get(HEADER_STREAM_TTL),
        expiresHeader: request.headers.get(HEADER_STREAM_EXPIRES_AT),
        requestUrl: request.url,
      });

      return new Response(null, {
        status: result.status,
        headers: result.headers,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal error";

      // Map specific errors to appropriate HTTP status codes
      if (message === "content-type mismatch") {
        return errorResponse(409, message);
      }
      if (message === "stream closed status mismatch") {
        return errorResponse(409, message);
      }
      if (message === "stream TTL/expiry mismatch") {
        return errorResponse(409, message);
      }
      if (message === "Storage quota exceeded") {
        return errorResponse(507, message);
      }
      if (message === "Body size too large") {
        return errorResponse(413, message);
      }

      return errorResponse(500, message);
    }
  });
}
