import type { Context } from "hono";
import {
  HEADER_STREAM_READER_KEY,
} from "../../shared/headers";
import { errorResponse } from "../../shared/errors";
import { Timing, attachTiming } from "../../shared/timing";
import { logError } from "../../../log";
import { applyCorsHeaders } from "../../middleware/cors";
import type { ProjectConfig, ProjectJwtClaims } from "../../middleware/auth";
import { bridgeSseViaWebSocket } from "../../middleware/sse-bridge";
import { lookupEdgeCache, storeInEdgeCache, writeStreamCreationMetadata } from "../../middleware/cache";
import type { StreamMeta } from "../../middleware/cache";
import {
  tryCoalesceInFlight,
  resolveInFlightWaiters,
  MAX_IN_FLIGHT,
} from "../../middleware/coalesce";
import type { InFlightResult } from "../../middleware/coalesce";
import { getStreamEntry } from "../../../storage/registry";
import type { BaseEnv } from "../../index";

// ============================================================================
// Types
// ============================================================================

type AppEnv<E extends BaseEnv> = {
  Bindings: E;
  Variables: {
    projectConfig: ProjectConfig | null;
    jwtClaims: ProjectJwtClaims | null;
    projectId: string | null;
    streamId: string | null;
    streamPath: string | null;
    corsOrigin: string | null;
  };
};

type StreamAuthResult = { streamMeta: StreamMeta | null };

// ============================================================================
// Internal Helpers
// ============================================================================

function wrapAuthError(result: { status: number; error: string }, origin: string | null): Response {
  const resp = errorResponse(result.status, result.error);
  applyCorsHeaders(resp.headers, origin);
  return resp;
}

/**
 * Look up stream metadata from KV.
 * Returns just the fields needed for edge caching (public, readerKey).
 * Returns null when the KV binding is missing or the key doesn't exist.
 */
async function getStreamMeta(kv: KVNamespace | undefined, doKey: string): Promise<StreamMeta | null> {
  if (!kv) return null;
  const entry = await getStreamEntry(kv, doKey);
  if (!entry) return null;
  return {
    public: entry.public,
    readerKey: entry.readerKey,
  };
}

// ============================================================================
// Authorization
// ============================================================================

// #region docs-authorize-request
/**
 * Authorize a stream request using JWT claims from middleware context.
 * For reads, public streams skip auth entirely (checked via KV before auth).
 * Stream metadata (including readerKey) is returned for use in HEAD headers
 * and cache guards.
 * Returns a StreamAuthResult on success, or an error Response on auth failure.
 */
async function authorizeStreamRequest<E extends BaseEnv>(
  doKey: string,
  env: E,
  jwtClaims: ProjectJwtClaims | null,
  isStreamRead: boolean,
  corsOrigin: string | null,
): Promise<StreamAuthResult | Response> {
  let streamMeta: StreamMeta | null = null;
  if (isStreamRead) {
    streamMeta = await getStreamMeta(env.REGISTRY, doKey);
    if (!streamMeta?.public) {
      // Non-public read: require valid JWT
      if (!jwtClaims) return wrapAuthError({ status: 401, error: "unauthorized" }, corsOrigin);
    }
  } else {
    // Mutation: require valid JWT with write scope
    if (!jwtClaims) return wrapAuthError({ status: 401, error: "unauthorized" }, corsOrigin);
    if (jwtClaims.scope !== "write" && jwtClaims.scope !== "manage") {
      return wrapAuthError({ status: 403, error: "forbidden" }, corsOrigin);
    }
  }
  return { streamMeta };
}
// #endregion docs-authorize-request

// ============================================================================
// Edge Handler Factory
// ============================================================================

export function createStreamHandler<E extends BaseEnv>(
  inFlight: Map<string, Promise<InFlightResult>>,
): (c: Context<AppEnv<E>>) => Promise<Response> {
  return async (c: Context<AppEnv<E>>): Promise<Response> => {
    // #region docs-request-arrives
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const timingEnabled =
      c.env.DEBUG_TIMING === "1" || request.headers.get("X-Debug-Timing") === "1";
    const timing = timingEnabled ? new Timing() : null;

    // #region docs-extract-stream-id
    const projectId = c.get("projectId");
    const doKey = c.get("streamPath");
    if (!projectId || !doKey) {
      return errorResponse(400, "missing project or stream id");
    }
    // #endregion docs-extract-stream-id

    const corsOrigin = c.get("corsOrigin");
    const jwtClaims = c.get("jwtClaims");

    const method = request.method.toUpperCase();
    const isStreamRead = method === "GET" || method === "HEAD";

    // Authorize the request
    const authResult = await authorizeStreamRequest(doKey, c.env, jwtClaims, isStreamRead, corsOrigin);
    if (authResult instanceof Response) return authResult;
    const { streamMeta } = authResult;

    // ================================================================
    // Edge cache: check for cached response before hitting the DO
    // ================================================================
    const isSse = method === "GET" && url.searchParams.get("live") === "sse";
    // Debug requests change the response format (JSON stats instead of
    // stream data) so they must never share a cache entry with normal reads.
    const hasDebugHeaders = request.headers.has("X-Debug-Coalesce");
    const cacheable = method === "GET" && !isSse && !hasDebugHeaders;
    const isLongPoll = cacheable && url.searchParams.get("live") === "long-poll";

    // Use the URL string for cache operations — passing the original
    // request object causes cache key mismatches in miniflare/workerd.
    const cacheUrl = cacheable ? request.url : null;

    // Track cache status for the X-Cache response header.
    // null = non-cacheable request (no header emitted).
    let cacheStatus: string | null = null;

    // Respect client Cache-Control: no-cache — skip lookup but still
    // store the fresh DO response so subsequent normal requests benefit.
    const clientCc = request.headers.get("Cache-Control") ?? "";
    const skipCacheLookup =
      clientCc.includes("no-cache") || clientCc.includes("no-store");

    if (cacheable && skipCacheLookup) {
      cacheStatus = "BYPASS";
    }

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

    // #region docs-route-to-do
    const stub = c.env.STREAMS.getByName(doKey);

    // SSE via internal WebSocket bridge
    if (isSse) {
      return bridgeSseViaWebSocket(stub, doKey, url, request, corsOrigin, timing);
    }

    // Register as the in-flight winner for this URL so concurrent
    // requests can coalesce on our result instead of hitting the DO.
    let resolveInFlight: ((r: InFlightResult) => void) | undefined;
    let rejectInFlight: ((e: unknown) => void) | undefined;
    if (cacheStatus === "MISS" && cacheUrl && !inFlight.has(cacheUrl) && inFlight.size < MAX_IN_FLIGHT) {
      inFlight.set(
        cacheUrl,
        new Promise<InFlightResult>((resolve, reject) => {
          resolveInFlight = resolve;
          rejectInFlight = reject;
        }),
      );
    }

    let response: Response;
    try {
      {
        const doneOrigin = timing?.start("edge.origin");
        response = await stub.routeStreamRequest(
          doKey,
          timingEnabled,
          request,
        );
        doneOrigin?.();
      }
    } catch (err) {
      logError({ doKey, method, component: "do-rpc" }, "DO routeStreamRequest failed", err);
      if (rejectInFlight && cacheUrl) {
        rejectInFlight(err);
        inFlight.delete(cacheUrl);
      }
      throw err;
    }
    // #endregion docs-route-to-do

    // Buffer body so it can be shared with coalesced waiters
    const bodyBuffer = await response.arrayBuffer();

    const responseHeaders = new Headers(response.headers);
    applyCorsHeaders(responseHeaders, corsOrigin);
    const wrapped = new Response(bodyBuffer, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

    // HEAD responses: include reader key so clients can discover it.
    // HEAD is always no-store, so this always hits the worker.
    if (method === "HEAD" && wrapped.ok && streamMeta?.readerKey) {
      wrapped.headers.set(HEADER_STREAM_READER_KEY, streamMeta.readerKey);
    }

    // On successful stream creation, write metadata to KV for edge lookups
    if (method === "PUT" && wrapped.status === 201 && c.env.REGISTRY) {
      writeStreamCreationMetadata(url, doKey, undefined, c.env.REGISTRY, (p) => c.executionCtx.waitUntil(p), wrapped);
    }

    // Edge cache: store cacheable 200 responses
    let storedInCache = false;
    if (cacheable && wrapped.status === 200 && cacheUrl) {
      storedInCache = storeInEdgeCache((p) => c.executionCtx.waitUntil(p), cacheUrl, isLongPoll, streamMeta, url, wrapped);
    }

    // Resolve in-flight promise so coalesced waiters get the result
    if (resolveInFlight && cacheUrl) {
      resolveInFlightWaiters(inFlight, cacheUrl, response, bodyBuffer, resolveInFlight, storedInCache);
    }

    // Set X-Cache header on cacheable responses so cache behavior
    // is observable by tests and operators in any environment.
    if (cacheStatus) {
      wrapped.headers.set("X-Cache", cacheStatus);
    }

    return attachTiming(wrapped, timing);
    // #endregion docs-request-arrives
  };
}
