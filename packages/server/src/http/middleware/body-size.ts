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
    // Only validate POST and PUT requests (both can have bodies)
    if (c.req.method !== "POST" && c.req.method !== "PUT") {
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
