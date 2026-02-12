import type { MiddlewareHandler } from "hono";
import { errorResponse } from "../shared/errors";

/**
 * Middleware that validates query parameters are not empty strings.
 * Returns 400 if any specified query parameter is present but empty.
 *
 * This prevents edge cases like ?offset= or ?cursor= which should be rejected.
 */
export function rejectEmptyQueryParams(paramNames: string[]): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);

    for (const paramName of paramNames) {
      const value = url.searchParams.get(paramName);
      if (value === "") {
        return errorResponse(400, `${paramName} parameter cannot be empty`);
      }
    }

    return next();
  };
}
