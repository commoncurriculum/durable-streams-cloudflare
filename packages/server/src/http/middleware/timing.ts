import { timing, startTime, endTime } from "hono/timing";
import type { MiddlewareHandler } from "hono";

// ============================================================================
// Hono Middleware using built-in timing
// ============================================================================

/**
 * Timing middleware using Hono's built-in timing.
 * Mounted on /v1/stream/*.
 * Always enabled to provide Server-Timing headers.
 */
export function timingMiddleware(): MiddlewareHandler {
  return timing();
}

/**
 * Helper to start a timer and return a function to end it.
 * Compatible with the old API: `const done = createTimer(c, "name"); done()`
 */
export function createTimer(c: any, name: string): () => void {
  startTime(c, name);
  return () => endTime(c, name);
}
