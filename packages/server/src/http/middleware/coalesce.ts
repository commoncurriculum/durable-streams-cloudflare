import { Timing, attachTiming } from "../shared/timing";
import { logWarn } from "../../log";
import { applyCorsHeaders } from "./cors";

export type InFlightResult = {
  body: ArrayBuffer;
  status: number;
  statusText: string;
  headers: [string, string][];
};

// How long resolved in-flight entries stay in the map so that requests
// arriving just after the winner resolves still get a HIT without
// waiting for caches.default.put() to complete.
export const COALESCE_LINGER_MS = 200;
export const MAX_IN_FLIGHT = 100_000;

/**
 * Check if another request is already fetching the same URL. If so, wait for
 * its result and return a Response. Returns null if no pending request exists
 * or if the pending request fails (caller should fall through to the DO).
 */
export async function tryCoalesceInFlight(
  inFlight: Map<string, Promise<InFlightResult>>,
  cacheUrl: string,
  corsOrigin: string | null,
  timing: Timing | null,
): Promise<Response | null> {
  const pending = inFlight.get(cacheUrl);
  if (!pending) return null;

  try {
    const coalesced = await pending;
    const headers = new Headers(coalesced.headers);
    headers.set("X-Cache", "HIT");
    applyCorsHeaders(headers, corsOrigin);
    return attachTiming(
      new Response(coalesced.body, {
        status: coalesced.status,
        statusText: coalesced.statusText,
        headers,
      }),
      timing,
    );
  } catch (e) {
    logWarn(
      { cacheUrl, component: "coalesce" },
      "coalesced request failed, falling through to DO",
      e,
    );
    return null;
  }
}

/**
 * Resolve the in-flight promise so coalesced waiters get the result.
 * Headers are captured from the DO response (before CORS) so each waiter
 * can apply its own CORS headers.
 *
 * When the response was stored in the edge cache, the entry lingers for
 * COALESCE_LINGER_MS so requests arriving just after resolution still find
 * the resolved promise (covers the gap before cache.put completes).
 * Otherwise deletes immediately to avoid serving stale data.
 */
export function resolveInFlightWaiters(
  inFlight: Map<string, Promise<InFlightResult>>,
  cacheUrl: string,
  response: Response,
  bodyBuffer: ArrayBuffer,
  resolve: (r: InFlightResult) => void,
  storedInCache: boolean,
): void {
  const rawHeaders: [string, string][] = [];
  for (const [k, v] of response.headers) {
    rawHeaders.push([k, v]);
  }
  resolve({
    body: bodyBuffer,
    status: response.status,
    statusText: response.statusText,
    headers: rawHeaders,
  });
  if (storedInCache) {
    // Linger so requests arriving just after resolution still find
    // the resolved promise (covers the gap before cache.put completes).
    const lingerPromise = inFlight.get(cacheUrl);
    setTimeout(() => {
      if (inFlight.get(cacheUrl) === lingerPromise) {
        inFlight.delete(cacheUrl);
      }
    }, COALESCE_LINGER_MS);
  } else {
    // Response was NOT cached (e.g., at-tail plain GET, 404, 204).
    // Delete immediately — lingering would serve stale data when
    // the stream's tail moves on the next append.
    inFlight.delete(cacheUrl);
  }
}
