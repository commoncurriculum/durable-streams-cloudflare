import { lookupEdgeCache, storeInEdgeCache, writeStreamCreationMetadata } from "./cache";
import {
  tryCoalesceInFlight,
  resolveInFlightWaiters,
  MAX_IN_FLIGHT,
} from "./coalesce";
import type { InFlightResult } from "./coalesce";
import { bridgeSseViaWebSocket } from "./sse-bridge";

// ============================================================================
// Hono Middleware (factory — needs closure over inFlight map)
// ============================================================================

/**
 * Edge cache + coalesce + SSE bridge middleware. Mounted on /v1/stream/*.
 *
 * Before handler:
 *   - Short-circuits SSE requests via WebSocket bridge
 *   - Returns cached responses on edge cache hit
 *   - Returns coalesced responses for duplicate in-flight requests
 *   - Registers as coalesce winner on cache MISS
 *
 * After handler:
 *   - Buffers response body (required for coalesce sharing)
 *   - Writes stream creation metadata to KV on PUT 201
 *   - Stores cacheable 200 responses in edge cache
 *   - Resolves in-flight promise for coalesced waiters
 *   - Sets X-Cache header
 */
// biome-ignore lint: Hono context typing is complex; middleware is wired through the app
export function createEdgeCacheMiddleware(inFlight: Map<string, Promise<InFlightResult>>) {
  return async (c: any, next: () => Promise<void>): Promise<void | Response> => {
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const method = request.method.toUpperCase();
    const timing = c.get("timing");

    // SSE via internal WebSocket bridge — completely different code path
    const isSse = method === "GET" && url.searchParams.get("live") === "sse";
    if (isSse) {
      const doKey = c.get("streamPath");
      const corsOrigin = c.get("corsOrigin");
      const stub = c.env.STREAMS.getByName(doKey);
      return bridgeSseViaWebSocket(stub, doKey, url, request, corsOrigin, timing);
    }

    const hasDebugHeaders = request.headers.has("X-Debug-Coalesce");
    const cacheable = method === "GET" && !hasDebugHeaders;
    const isLongPoll = cacheable && url.searchParams.get("live") === "long-poll";
    const cacheUrl = cacheable ? request.url : null;

    let cacheStatus: string | null = null;

    const clientCc = request.headers.get("Cache-Control") ?? "";
    const skipCacheLookup =
      clientCc.includes("no-cache") || clientCc.includes("no-store");

    if (cacheable && skipCacheLookup) {
      cacheStatus = "BYPASS";
    }

    const corsOrigin = c.get("corsOrigin");

    if (cacheable && !skipCacheLookup) {
      const cached = await lookupEdgeCache(request, cacheUrl!, corsOrigin, timing);
      if (cached) return cached;
      cacheStatus = "MISS";
    }

    // In-flight coalescing: deduplicate concurrent cache misses
    if (cacheStatus === "MISS" && cacheUrl) {
      const coalesced = await tryCoalesceInFlight(inFlight, cacheUrl, corsOrigin, timing);
      if (coalesced) return coalesced;
    }

    // Register as the in-flight winner so concurrent requests can coalesce
    let resolveCoalesce: ((r: InFlightResult) => void) | undefined;
    let rejectCoalesce: ((e: unknown) => void) | undefined;
    if (cacheStatus === "MISS" && cacheUrl && !inFlight.has(cacheUrl) && inFlight.size < MAX_IN_FLIGHT) {
      inFlight.set(
        cacheUrl,
        new Promise<InFlightResult>((resolve, reject) => {
          resolveCoalesce = resolve;
          rejectCoalesce = reject;
        }),
      );
    }

    try {
      await next();
    } catch (err) {
      if (rejectCoalesce && cacheUrl) {
        rejectCoalesce(err);
        inFlight.delete(cacheUrl);
      }
      throw err;
    }

    // --- After-phase: response post-processing ---

    // Buffer body so it can be shared with coalesced waiters
    const rawResponse = c.res;
    const bodyBuffer = await rawResponse.arrayBuffer();
    c.res = new Response(bodyBuffer, {
      status: rawResponse.status,
      statusText: rawResponse.statusText,
      headers: new Headers(rawResponse.headers),
    });

    // On successful stream creation, write metadata to KV for edge lookups
    if (method === "PUT" && c.res.status === 201 && c.env.REGISTRY) {
      const doKey = c.get("streamPath");
      writeStreamCreationMetadata(url, doKey, undefined, c.env.REGISTRY, (p: Promise<unknown>) => c.executionCtx.waitUntil(p), c.res);
    }

    // Store cacheable 200 responses in edge cache
    const streamMeta = c.get("streamMeta");
    let storedInCache = false;
    if (cacheable && c.res.status === 200 && cacheUrl) {
      storedInCache = storeInEdgeCache(
        (p: Promise<unknown>) => c.executionCtx.waitUntil(p),
        cacheUrl,
        isLongPoll,
        streamMeta,
        url,
        c.res,
      );
    }

    // Resolve in-flight promise so coalesced waiters get the result.
    // Use rawResponse headers (pre-enrichment) so each waiter applies its own CORS.
    if (resolveCoalesce && cacheUrl) {
      resolveInFlightWaiters(inFlight, cacheUrl, rawResponse, bodyBuffer, resolveCoalesce, storedInCache);
    }

    // X-Cache header on cacheable responses
    if (cacheStatus) {
      c.res.headers.set("X-Cache", cacheStatus);
    }
  };
}
