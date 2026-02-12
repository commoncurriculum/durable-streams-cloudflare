// #region docs-error-response
import { baseHeaders } from "./headers";

export function errorResponse(status: number, message: string): Response {
  const headers = baseHeaders({ "Cache-Control": "no-store" });
  return Response.json({ error: message }, { status, headers });
}
// #endregion docs-error-response

/**
 * Custom error class that carries an HTTP status code and optional pre-built Response.
 * Thrown by domain functions and caught by HTTP handlers to return the correct status.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly response?: Response;

  constructor(status: number, message: string, response?: Response) {
    super(message);
    this.name = "HttpError";
    this.status = status;
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
    return errorResponse(err.status, err.message);
  }
  const message = err instanceof Error ? err.message : "Internal error";
  return errorResponse(500, message);
}
