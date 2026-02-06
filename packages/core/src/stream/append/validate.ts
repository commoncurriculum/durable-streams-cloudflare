/**
 * POST validation helpers.
 *
 * This file uses two validator patterns (see shared.ts for details):
 * - Simple validators return `Response | null` for brevity
 * - Complex validators return `Result<T>` for composability
 */

import { normalizeContentType } from "../../protocol/headers";
import { errorResponse } from "../../protocol/errors";
import { validateStreamSeq, buildClosedConflict } from "../close";
import type { StreamMeta } from "../../storage/types";
import type { ParsedPostInput, ValidatedPostInput, Result } from "../types";

/**
 * Validate that a stream exists.
 * Returns an error response if stream not found.
 */
export function validateStreamExists(meta: StreamMeta | null): Result<StreamMeta> {
  if (!meta) {
    return { kind: "error", response: errorResponse(404, "stream not found") };
  }
  return { kind: "ok", value: meta };
}

/**
 * Check if this is a close-only operation (empty body with close flag).
 */
export function isCloseOnlyOperation(input: ParsedPostInput): boolean {
  return input.bodyBytes.length === 0 && input.closeStream;
}

/**
 * Type guard that checks if content-type is present.
 * Narrows input.contentType from `string | null` to `string`.
 */
export function hasContentType<T extends { contentType: string | null }>(
  input: T,
): input is T & { contentType: string } {
  return input.contentType !== null;
}

/**
 * Validate content-type matches the stream's content-type.
 * Assumes content-type is already validated as non-null via hasContentType.
 * Returns an error response if mismatch, null if valid.
 */
export function validateContentTypeMatch(
  requestContentType: string,
  streamContentType: string,
): Response | null {
  if (normalizeContentType(streamContentType) !== requestContentType) {
    return errorResponse(409, "content-type mismatch");
  }
  return null;
}

/**
 * Validate that the stream is not closed for append operations.
 * Returns the closed conflict response if stream is closed.
 */
export function validateStreamNotClosed(
  meta: StreamMeta,
  nextOffsetHeader: string,
): Response | null {
  if (meta.closed === 1) {
    return buildClosedConflict(meta, nextOffsetHeader);
  }
  return null;
}

/**
 * Validate that body is not empty for non-close operations.
 * Returns an error response if body is empty without close flag.
 */
export function validateNonEmptyBody(
  bodyLength: number,
  closeStream: boolean,
): Response | null {
  if (bodyLength === 0 && !closeStream) {
    return errorResponse(400, "empty body");
  }
  return null;
}

/**
 * Full validation for POST input.
 * Returns validated input ready for execution.
 */
export function validatePostInput(
  input: ParsedPostInput,
  meta: StreamMeta,
  encodedTailOffset: string,
): Result<ValidatedPostInput> {
  // Check if this is a close-only operation
  if (isCloseOnlyOperation(input)) {
    return {
      kind: "ok",
      value: {
        kind: "close_only",
        streamId: input.streamId,
        meta,
        producer: input.producer,
      },
    };
  }

  // Empty body without close flag is an error
  const emptyError = validateNonEmptyBody(input.bodyBytes.length, input.closeStream);
  if (emptyError) {
    return { kind: "error", response: emptyError };
  }

  // Stream must not be closed for append operations
  const closedError = validateStreamNotClosed(meta, encodedTailOffset);
  if (closedError) {
    return { kind: "error", response: closedError };
  }

  // Content-type is required
  if (!hasContentType(input)) {
    return { kind: "error", response: errorResponse(400, "Content-Type is required") };
  }

  // Content-type must match stream's content-type
  const contentTypeError = validateContentTypeMatch(input.contentType, meta.content_type);
  if (contentTypeError) {
    return { kind: "error", response: contentTypeError };
  }

  // Validate stream sequence if provided
  const seqError = validateStreamSeq(meta, input.streamSeq);
  if (seqError) {
    return { kind: "error", response: seqError };
  }

  return {
    kind: "ok",
    value: {
      kind: "append",
      meta,
      streamId: input.streamId,
      contentType: input.contentType,
      bodyBytes: input.bodyBytes,
      streamSeq: input.streamSeq,
      producer: input.producer,
      closeStream: input.closeStream,
    },
  };
}
