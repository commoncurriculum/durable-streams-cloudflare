import {
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_EXPIRES_AT,
  HEADER_STREAM_SEQ,
  HEADER_STREAM_TTL,
  isJsonContentType,
  normalizeContentType,
} from "../../protocol/headers";
import { parseExpiresAt, parseTtlSeconds } from "../../protocol/expiry";
import { parseProducerHeaders } from "../producer";
import type { RawPutInput, ParsedPutInput, Result } from "../types";
import { errorResponse } from "../../protocol/errors";

function parseContentType(request: Request): string | null {
  return normalizeContentType(request.headers.get("Content-Type"));
}

/**
 * Extract raw data from a PUT request.
 * This is a simple data extraction with no validation logic.
 */
export async function extractPutInput(
  streamId: string,
  request: Request,
): Promise<RawPutInput> {
  const bodyBytes = new Uint8Array(await request.arrayBuffer());

  return {
    streamId,
    contentTypeHeader: parseContentType(request),
    closedHeader: request.headers.get(HEADER_STREAM_CLOSED),
    ttlHeader: request.headers.get(HEADER_STREAM_TTL),
    expiresHeader: request.headers.get(HEADER_STREAM_EXPIRES_AT),
    streamSeqHeader: request.headers.get(HEADER_STREAM_SEQ),
    publicHeader: request.headers.get("X-Stream-Public"),
    bodyBytes,
    producer: parseProducerHeaders(request),
    requestUrl: request.url,
  };
}

/**
 * Parse and normalize raw PUT input into a validated structure.
 * Returns an error result if parsing fails (TTL/expiry headers).
 */
export function parsePutInput(raw: RawPutInput, now: number): Result<ParsedPutInput> {
  // Check for mutually exclusive headers
  if (raw.ttlHeader && raw.expiresHeader) {
    return {
      kind: "error",
      response: errorResponse(400, "Stream-TTL and Stream-Expires-At are mutually exclusive"),
    };
  }

  // Parse TTL
  const ttlSeconds = parseTtlSeconds(raw.ttlHeader);
  if (ttlSeconds.error) {
    return { kind: "error", response: errorResponse(400, ttlSeconds.error) };
  }

  // Parse expires-at
  const expiresAt = parseExpiresAt(raw.expiresHeader);
  if (expiresAt.error) {
    return { kind: "error", response: errorResponse(400, expiresAt.error) };
  }

  // Check for producer header parse errors
  if (raw.producer?.error) {
    return { kind: "error", response: raw.producer.error };
  }

  // Calculate effective expiry
  const effectiveExpiresAt =
    ttlSeconds.value !== null ? now + ttlSeconds.value * 1000 : expiresAt.value;

  // Normalize body for empty JSON arrays
  let bodyBytes = raw.bodyBytes;
  if (
    bodyBytes.length > 0 &&
    isJsonContentType(raw.contentTypeHeader ?? "application/octet-stream")
  ) {
    const text = new TextDecoder().decode(bodyBytes);
    try {
      const value = JSON.parse(text);
      if (Array.isArray(value) && value.length === 0) {
        bodyBytes = new Uint8Array();
      }
    } catch {
      // invalid JSON handled later in append path
    }
  }

  return {
    kind: "ok",
    value: {
      streamId: raw.streamId,
      contentType: raw.contentTypeHeader,
      requestedClosed: raw.closedHeader === "true",
      isPublic: raw.publicHeader === "true",
      ttlSeconds: ttlSeconds.value,
      effectiveExpiresAt: effectiveExpiresAt ?? null,
      bodyBytes,
      streamSeq: raw.streamSeqHeader,
      producer: raw.producer?.value ?? null,
      requestUrl: raw.requestUrl,
      now,
    },
  };
}
