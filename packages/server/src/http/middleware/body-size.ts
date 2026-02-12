import type { MiddlewareHandler } from "hono";
import { errorResponse } from "../shared/errors";

/**
 * Middleware that validates Content-Length header before the body is read.
 * Returns 413 if the declared size exceeds maxSize.
 *
 * This must run BEFORE any handler reads request.body or request.arrayBuffer().
 */
export function bodySizeLimit(maxSize: number): MiddlewareHandler {
  return async (c, next) => {
    // Only validate POST requests (GET, HEAD, DELETE, PUT don't have bodies in this API)
    if (c.req.method !== "POST") {
      return next();
    }

    const contentLength = c.req.header("Content-Length");

    if (contentLength) {
      const size = Number.parseInt(contentLength, 10);
      if (Number.isFinite(size) && size > maxSize) {
        return errorResponse(413, "payload too large");
      }
    }

    return next();
  };
}
