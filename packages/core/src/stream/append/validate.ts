import { normalizeContentType } from "../../protocol/headers";
import { errorResponse } from "../../protocol/errors";
import { validateStreamSeq, buildClosedConflict } from "../close";
import type { StreamMeta } from "../../storage/types";
import type { ParsedPostInput, ValidatedPostInput, Result } from "../types";

/**
 * Validate that a stream exists.
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
 * The stream's stored content-type is normalized (parameters like charset stripped,
 * lowercased) before comparison. The request content-type is already normalized
 * by parsePostInput. This means `application/json; charset=utf-8` and
 * `application/json` are treated as equivalent.
 */
export function validateContentTypeMatch(
  requestContentType: string,
  streamContentType: string,
): Result<null> {
  if (normalizeContentType(streamContentType) !== requestContentType) {
    return { kind: "error", response: errorResponse(409, "content-type mismatch") };
  }
  return { kind: "ok", value: null };
}

/**
 * Validate that the stream is not closed for append operations.
 */
export function validateStreamNotClosed(
  meta: StreamMeta,
  nextOffsetHeader: string,
): Result<null> {
  if (meta.closed === 1) {
    return { kind: "error", response: buildClosedConflict(meta, nextOffsetHeader) };
  }
  return { kind: "ok", value: null };
}

/**
 * Validate that body is not empty for non-close operations.
 */
export function validateNonEmptyBody(
  bodyLength: number,
  closeStream: boolean,
): Result<null> {
  if (bodyLength === 0 && !closeStream) {
    return { kind: "error", response: errorResponse(400, "empty body") };
  }
  return { kind: "ok", value: null };
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
  const emptyResult = validateNonEmptyBody(input.bodyBytes.length, input.closeStream);
  if (emptyResult.kind === "error") return emptyResult;

  // Stream must not be closed for append operations
  const closedResult = validateStreamNotClosed(meta, encodedTailOffset);
  if (closedResult.kind === "error") return closedResult;

  // Content-type is required
  if (!hasContentType(input)) {
    return { kind: "error", response: errorResponse(400, "Content-Type is required") };
  }

  // Content-type must match stream's content-type
  const contentTypeResult = validateContentTypeMatch(input.contentType, meta.content_type);
  if (contentTypeResult.kind === "error") return contentTypeResult;

  // Validate stream sequence if provided
  const seqResult = validateStreamSeq(meta, input.streamSeq);
  if (seqResult.kind === "error") return seqResult;

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
