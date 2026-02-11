import { timing } from "hono/timing";
import { Timing, appendServerTiming } from "../shared/timing";

// ============================================================================
// Hono Middleware
// ============================================================================

/**
 * Debug timing middleware. Mounted on /v1/stream/*.
 * Creates a Timing instance when enabled (via env or header), stores it in
 * context for downstream use, and appends the Server-Timing header after.
 * 
 * Uses Hono's built-in timing middleware for Server-Timing header generation.
 */
// biome-ignore lint: Hono context typing is complex; middleware is wired through the app
export async function timingMiddleware(c: any, next: () => Promise<void>): Promise<void> {
  const timingEnabled =
    c.env.DEBUG_TIMING === "1" || c.req.raw.headers.get("X-Debug-Timing") === "1";
  
  if (!timingEnabled) {
    c.set("timing", null);
    return next();
  }

  // Use Hono's built-in timing middleware when enabled
  const honoTiming = timing();
  await honoTiming(c, async () => {
    // Also keep our custom Timing for internal use
    const customTiming = new Timing();
    c.set("timing", customTiming);
    await next();
    // Append custom timing to Server-Timing header
    appendServerTiming(c.res.headers, customTiming);
  });
}
