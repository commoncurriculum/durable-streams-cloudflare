import { Timing, appendServerTiming } from "../shared/timing";

// ============================================================================
// Hono Middleware
// ============================================================================

/**
 * Debug timing middleware. Mounted on /v1/stream/*.
 * Creates a Timing instance when enabled (via env or header), stores it in
 * context for downstream use, and appends the Server-Timing header after.
 */
// biome-ignore lint: Hono context typing is complex; middleware is wired through the app
export async function timingMiddleware(c: any, next: () => Promise<void>): Promise<void> {
  const timingEnabled =
    c.env.DEBUG_TIMING === "1" || c.req.raw.headers.get("X-Debug-Timing") === "1";
  const timing = timingEnabled ? new Timing() : null;
  c.set("timing", timing);

  await next();

  appendServerTiming(c.res.headers, timing);
}
