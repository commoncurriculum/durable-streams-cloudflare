import { MAX_APPEND_BYTES } from "../protocol/limits";
import { errorResponse } from "../protocol/errors";

/**
 * Shared validators for mutation operations (PUT/POST).
 *
 * VALIDATOR PATTERNS:
 * This codebase uses two validator return patterns:
 *
 * 1. `Response | null` - Simple validators that check a single condition.
 *    Returns error Response if invalid, null if valid.
 *    Usage: `const err = validateX(...); if (err) return err;`
 *    Examples: validateContentLength, validateBodySize
 *
 * 2. `Result<T>` - Complex validators that transform input or aggregate checks.
 *    Returns discriminated union { kind: "ok", value: T } | { kind: "error", response: Response }
 *    Usage: `const result = validateX(...); if (result.kind === "error") return result;`
 *    Examples: validatePutInput, validatePostInput, validateStreamExists
 *
 * For new validators, prefer `Result<T>` for composability and type safety.
 * Simple single-check validators may use `Response | null` for brevity.
 */

/**
 * Validate Content-Length header matches actual body length.
 * Returns an error response if validation fails, null if valid.
 */
export function validateContentLength(
  contentLengthHeader: string | null,
  bodyLength: number,
): Response | null {
  if (!contentLengthHeader) return null;

  const expected = Number.parseInt(contentLengthHeader, 10);
  if (!Number.isFinite(expected)) {
    return errorResponse(400, "invalid Content-Length");
  }
  if (expected !== bodyLength) {
    return errorResponse(400, "content-length mismatch");
  }
  return null;
}

/**
 * Validate body size is within limits.
 * Returns an error response if too large, null if valid.
 */
export function validateBodySize(bodyLength: number): Response | null {
  if (bodyLength > MAX_APPEND_BYTES) {
    return errorResponse(413, "payload too large");
  }
  return null;
}
