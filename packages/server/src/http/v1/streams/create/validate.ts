import { normalizeContentType } from "../../../shared/headers";
import { ttlMatches } from "../../../shared/expiry";
import { errorResponse } from "../../../shared/errors";
import type { StreamMeta } from "../../../../storage/types";
import type { ParsedPutInput, ValidatedPutInput, Result } from "../types";

/**
 * Validate PUT input for an idempotent request (stream already exists).
 * Checks content-type, closed status, and TTL/expiry match.
 */
export function validateIdempotentPut(
  input: ParsedPutInput,
  existing: StreamMeta,
): Result<{ kind: "idempotent"; existing: StreamMeta; streamId: string }> {
  // Content-type must match
  const contentType = input.contentType ?? existing.content_type;
  if (normalizeContentType(existing.content_type) !== contentType) {
    return { kind: "error", response: errorResponse(409, "content-type mismatch") };
  }

  // Closed status must match
  if (input.requestedClosed !== (existing.closed === 1)) {
    return { kind: "error", response: errorResponse(409, "stream closed status mismatch") };
  }

  // TTL/expiry must match
  if (!ttlMatches(existing, input.ttlSeconds, input.effectiveExpiresAt)) {
    return { kind: "error", response: errorResponse(409, "stream TTL/expiry mismatch") };
  }

  return {
    kind: "ok",
    value: { kind: "idempotent", existing, streamId: input.streamId },
  };
}

/**
 * Validate PUT input for creating a new stream.
 */
export function validateNewStream(
  input: ParsedPutInput,
): Result<ValidatedPutInput> {
  // Default to application/octet-stream when Content-Type is omitted
  const contentType = input.contentType ?? "application/octet-stream";

  return {
    kind: "ok",
    value: {
      kind: "create",
      streamId: input.streamId,
      contentType,
      requestedClosed: input.requestedClosed,
      isPublic: input.isPublic,
      ttlSeconds: input.ttlSeconds,
      effectiveExpiresAt: input.effectiveExpiresAt,
      bodyBytes: input.bodyBytes,
      streamSeq: input.streamSeq,
      producer: input.producer,
      requestUrl: input.requestUrl,
      now: input.now,
    },
  };
}

/**
 * Full validation for PUT input.
 * Returns validated input ready for execution.
 */
export function validatePutInput(
  input: ParsedPutInput,
  existing: StreamMeta | null,
): Result<ValidatedPutInput> {
  if (existing) {
    return validateIdempotentPut(input, existing);
  }
  return validateNewStream(input);
}
