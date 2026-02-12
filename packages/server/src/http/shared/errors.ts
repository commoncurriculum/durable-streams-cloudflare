// #region docs-error-response
import { type } from "arktype";
import { baseHeaders } from "./headers";

// ============================================================================
// Error codes — machine-readable identifiers for every error the API returns.
// ============================================================================

export enum ErrorCode {
  // Auth
  UNAUTHORIZED = "UNAUTHORIZED",
  FORBIDDEN = "FORBIDDEN",

  // Not found
  STREAM_NOT_FOUND = "STREAM_NOT_FOUND",
  PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND",

  // Validation — general
  INVALID_OFFSET = "INVALID_OFFSET",
  EMPTY_BODY = "EMPTY_BODY",
  EMPTY_JSON_ARRAY = "EMPTY_JSON_ARRAY",
  EMPTY_QUERY_PARAM = "EMPTY_QUERY_PARAM",
  INVALID_CONTENT_LENGTH = "INVALID_CONTENT_LENGTH",
  CONTENT_LENGTH_MISMATCH = "CONTENT_LENGTH_MISMATCH",
  CONTENT_TYPE_REQUIRED = "CONTENT_TYPE_REQUIRED",
  MISSING_PROJECT_OR_STREAM_ID = "MISSING_PROJECT_OR_STREAM_ID",
  INVALID_JSON = "INVALID_JSON",
  OFFSET_REQUIRED = "OFFSET_REQUIRED",
  OFFSET_BEYOND_TAIL = "OFFSET_BEYOND_TAIL",

  // Payload limits
  PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE",
  STORAGE_QUOTA_EXCEEDED = "STORAGE_QUOTA_EXCEEDED",

  // Conflict — streams
  CONTENT_TYPE_MISMATCH = "CONTENT_TYPE_MISMATCH",
  STREAM_CLOSED = "STREAM_CLOSED",
  STREAM_CLOSED_STATUS_MISMATCH = "STREAM_CLOSED_STATUS_MISMATCH",
  STREAM_TTL_MISMATCH = "STREAM_TTL_MISMATCH",
  STREAM_SEQ_REGRESSION = "STREAM_SEQ_REGRESSION",

  // Conflict — producers
  STALE_PRODUCER_EPOCH = "STALE_PRODUCER_EPOCH",
  PRODUCER_SEQUENCE_GAP = "PRODUCER_SEQUENCE_GAP",
  PRODUCER_SEQ_MUST_START_AT_ZERO = "PRODUCER_SEQ_MUST_START_AT_ZERO",
  PRODUCER_HEADERS_INCOMPLETE = "PRODUCER_HEADERS_INCOMPLETE",
  PRODUCER_ID_INVALID = "PRODUCER_ID_INVALID",
  PRODUCER_EPOCH_SEQ_NOT_INTEGERS = "PRODUCER_EPOCH_SEQ_NOT_INTEGERS",
  PRODUCER_EPOCH_SEQ_OVERFLOW = "PRODUCER_EPOCH_SEQ_OVERFLOW",
  PRODUCER_EVAL_FAILED = "PRODUCER_EVAL_FAILED",

  // TTL / expiry validation
  TTL_EXPIRES_MUTUALLY_EXCLUSIVE = "TTL_EXPIRES_MUTUALLY_EXCLUSIVE",
  INVALID_TTL = "INVALID_TTL",
  INVALID_EXPIRES_AT = "INVALID_EXPIRES_AT",

  // Server errors
  INTERNAL_ERROR = "INTERNAL_ERROR",
  SEGMENT_UNAVAILABLE = "SEGMENT_UNAVAILABLE",
  SEGMENT_MISSING = "SEGMENT_MISSING",
  SEGMENT_TRUNCATED = "SEGMENT_TRUNCATED",
  BATCH_BUILD_FAILED = "BATCH_BUILD_FAILED",

  // Realtime
  TOO_MANY_SSE_CONNECTIONS = "TOO_MANY_SSE_CONNECTIONS",
  WEBSOCKET_UPGRADE_REQUIRED = "WEBSOCKET_UPGRADE_REQUIRED",
}

// ============================================================================
// Schema & types
// ============================================================================

const errorCodeValues = Object.values(ErrorCode) as [string, ...string[]];

export const errorResponseSchema = type({
  code: type.enumerated(...errorCodeValues),
  error: "string",
});

export type ErrorResponse = typeof errorResponseSchema.infer;

// ============================================================================
// Helpers
// ============================================================================

export function errorResponse(status: number, code: ErrorCode, message: string): Response {
  const headers = baseHeaders({ "Cache-Control": "no-store" });
  const data: ErrorResponse = { code, error: message };
  return Response.json(data, { status, headers });
}
// #endregion docs-error-response

/**
 * Custom error class that carries an HTTP status code, error code, and optional pre-built Response.
 * Thrown by domain functions and caught by HTTP handlers to return the correct status.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly response?: Response;

  constructor(status: number, code: ErrorCode, message: string, response?: Response) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.response = response;
  }
}

/**
 * Convert a caught error into an HTTP Response.
 * If the error is an HttpError with a pre-built response, return it directly.
 * If the error is an HttpError with just a status, build an errorResponse.
 * Otherwise return 500.
 */
export function errorToResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    if (err.response) return err.response;
    return errorResponse(err.status, err.code, err.message);
  }
  const message = err instanceof Error ? err.message : "Internal error";
  return errorResponse(500, ErrorCode.INTERNAL_ERROR, message);
}
