import { MAX_APPEND_BYTES } from "../../../shared/limits";
import { errorResponse } from "../../../shared/errors";
import type { Result } from "../types";

/**
 * Validate Content-Length header matches actual body length.
 */
export function validateContentLength(
  contentLengthHeader: string | null,
  bodyLength: number,
): Result<null> {
  if (!contentLengthHeader) return { kind: "ok", value: null };

  const expected = Number.parseInt(contentLengthHeader, 10);
  if (!Number.isFinite(expected)) {
    return { kind: "error", response: errorResponse(400, "invalid Content-Length") };
  }
  if (expected !== bodyLength) {
    return { kind: "error", response: errorResponse(400, "content-length mismatch") };
  }
  return { kind: "ok", value: null };
}

/**
 * Validate body size is within limits.
 */
export function validateBodySize(bodyLength: number): Result<null> {
  if (bodyLength > MAX_APPEND_BYTES) {
    return { kind: "error", response: errorResponse(413, "payload too large") };
  }
  return { kind: "ok", value: null };
}
