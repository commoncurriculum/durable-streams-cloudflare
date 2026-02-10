import { Hono } from "hono";
import type { Context } from "hono";
import {
  HEADER_SSE_DATA_ENCODING,
  HEADER_STREAM_READER_KEY,
  HEADER_STREAM_UP_TO_DATE,
} from "../protocol/headers";
import { errorResponse } from "../protocol/errors";
import { Timing, attachTiming } from "../protocol/timing";
import { logError, logWarn } from "../log";
import { applyCorsHeaders } from "./hono";
import type { AuthorizeMutation, AuthorizeRead, ProjectConfig } from "./auth";
import { lookupProjectConfig, checkProjectJwt } from "./auth";
import { parseStreamPath, PROJECT_ID_PATTERN } from "./stream-path";
import type { StreamDO } from "./durable_object";
import { configRoutes } from "./config-routes";
import { buildSseDataEvent } from "./handlers/realtime";
import type { WsDataMessage, WsControlMessage } from "./handlers/realtime";
import { putStreamMetadata, getStreamEntry, type StreamEntry } from "../storage/registry";


// ============================================================================
// Types
// ============================================================================

export type BaseEnv = {
  STREAMS: DurableObjectNamespace<StreamDO>;
  R2?: R2Bucket;
  DEBUG_TIMING?: string;
  METRICS?: AnalyticsEngineDataset;
  /**
   * KV namespace storing per-project signing secrets and stream metadata.
   * SECURITY: Must use private ACL — contains JWT signing secrets.
   */
  REGISTRY: KVNamespace;
};

export type StreamWorkerConfig<E extends BaseEnv = BaseEnv> = {
  authorizeMutation?: AuthorizeMutation<E>;
  authorizeRead?: AuthorizeRead<E>;

};

// ============================================================================
// Internal Helpers
// ============================================================================

export { PROJECT_ID_PATTERN } from "./stream-path";

/**
 * Resolve the CORS origin for a request from per-project config.
 * Returns null (no CORS headers) when no corsOrigins are configured.
 * Returns "*" when corsOrigins includes "*".
 * Returns the matching origin when the request Origin matches a configured origin.
 * Returns the first configured origin when no match.
 */
function resolveProjectCorsOrigin(corsOrigins: string[] | undefined, requestOrigin: string | null): string | null {
  if (!corsOrigins || corsOrigins.length === 0) return null;
  if (corsOrigins.includes("*")) return "*";
  if (requestOrigin && corsOrigins.includes(requestOrigin)) return requestOrigin;
  return corsOrigins[0];
}

function wrapAuthError(result: { status: number; error: string }, origin: string | null): Response {
  const resp = errorResponse(result.status, result.error);
  applyCorsHeaders(resp.headers, origin);
  return resp;
}

/**
 * Simplified stream metadata for edge caching decisions.
 * This is a subset of StreamEntry - just the fields needed for cache control.
 */
type StreamMeta = Pick<StreamEntry, "public" | "readerKey">;

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
// SSE-via-WebSocket Bridge
// ============================================================================

const sseTextEncoder = new TextEncoder();

async function bridgeSseViaWebSocket(
  stub: DurableObjectStub<StreamDO>,
  doKey: string,
  url: URL,
  _request: Request,
  corsOrigin: string | null,
  timing: Timing | null,
): Promise<Response> {
  // Build the internal WS upgrade request to the DO.
  // Must use stub.fetch() (not RPC) because WebSocket upgrade responses
  // can't be serialized over RPC.
  const wsUrl = new URL(url);
  wsUrl.searchParams.set("live", "ws-internal");
  const wsReq = new Request(wsUrl.toString(), {
    headers: new Headers({
      Upgrade: "websocket",
    }),
  });

  const doneOrigin = timing?.start("edge.origin");
  const wsResp = await stub.fetch(wsReq);
  doneOrigin?.();

  if (wsResp.status !== 101 || !wsResp.webSocket) {
    // DO returned an error (400, 404, etc.) — forward as-is with CORS
    const headers = new Headers(wsResp.headers);
    applyCorsHeaders(headers, corsOrigin);
    return new Response(wsResp.body, {
      status: wsResp.status,
      statusText: wsResp.statusText,
      headers,
    });
  }

  const ws = wsResp.webSocket;
  ws.accept();

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  // Encoding is set by the DO in the 101 response headers
  const useBase64 = wsResp.headers.get("Stream-SSE-Data-Encoding") === "base64";

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data as string) as WsDataMessage | WsControlMessage;

      if (msg.type === "data") {
        const dataMsg = msg as WsDataMessage;

        if (dataMsg.encoding === "base64") {
          // Decode base64 back to binary, then build SSE event
          const binary = Uint8Array.from(atob(dataMsg.payload), (c) => c.charCodeAt(0));
          const sseEvent = buildSseDataEvent(binary.buffer as ArrayBuffer, true);
          // Fire-and-forget: SSE write to closed/errored stream is non-fatal
          writer.write(sseTextEncoder.encode(sseEvent)).catch(() => {});
        } else {
          // Text payload — build SSE event from the raw text
          const encoded = sseTextEncoder.encode(dataMsg.payload);
          const sseEvent = buildSseDataEvent(encoded.buffer as ArrayBuffer, false);
          // Fire-and-forget: SSE write to closed/errored stream is non-fatal
          writer.write(sseTextEncoder.encode(sseEvent)).catch(() => {});
        }
      } else if (msg.type === "control") {
        const controlMsg = msg as WsControlMessage;
        // Build SSE control event directly from the WS message — do NOT
        // use buildSseControlEvent() which would double-process the cursor
        // through generateResponseCursor() (the DO already computed it).
        const control: Record<string, unknown> = {
          streamNextOffset: controlMsg.streamNextOffset,
        };
        if (controlMsg.streamWriteTimestamp && controlMsg.streamWriteTimestamp > 0) {
          control.streamWriteTimestamp = controlMsg.streamWriteTimestamp;
        }
        if (controlMsg.streamClosed) {
          control.streamClosed = true;
        }
        if (controlMsg.streamCursor) {
          control.streamCursor = controlMsg.streamCursor;
        }
        if (controlMsg.upToDate) {
          control.upToDate = true;
        }
        const ssePayload = `event: control\ndata:${JSON.stringify(control)}\n\n`;
        // Fire-and-forget: SSE write to closed/errored stream is non-fatal
        writer.write(sseTextEncoder.encode(ssePayload)).catch(() => {});
      }
    } catch (e) {
      logWarn({ doKey, component: "ws-bridge" }, "malformed WS message", e);
    }
  });

  ws.addEventListener("close", () => {
    // Fire-and-forget: writer may already be closed
    writer.close().catch(() => {});
  });

  ws.addEventListener("error", () => {
    // Fire-and-forget: writer may already be closed
    writer.close().catch(() => {});
  });

  // Build SSE response headers
  const sseHeaders = new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  applyCorsHeaders(sseHeaders, corsOrigin);

  if (useBase64) sseHeaders.set(HEADER_SSE_DATA_ENCODING, "base64");

  return attachTiming(new Response(readable, { status: 200, headers: sseHeaders }), timing);
}

// ============================================================================
// In-flight request coalescing types
// ============================================================================

type InFlightResult = {
  body: ArrayBuffer;
  status: number;
  statusText: string;
  headers: [string, string][];
};

// How long resolved in-flight entries stay in the map so that requests
// arriving just after the winner resolves still get a HIT without
// waiting for caches.default.put() to complete.
const COALESCE_LINGER_MS = 200;
const MAX_IN_FLIGHT = 100_000;

// ============================================================================
// Authorization
// ============================================================================

type StreamAuthResult = { streamMeta: StreamMeta | null };

// #region docs-authorize-request
/**
 * Authorize a stream request. For reads, public streams skip auth entirely
 * (checked via KV before auth). Stream metadata (including readerKey) is
 * returned for use in HEAD headers and cache guards.
 * Returns a StreamAuthResult on success, or an error Response on auth failure.
 */
async function authorizeStreamRequest<E extends BaseEnv>(
  request: Request,
  doKey: string,
  env: E,
  config: StreamWorkerConfig<E> | undefined,
  isStreamRead: boolean,
  corsOrigin: string | null,
  timing: Timing | null,
): Promise<StreamAuthResult | Response> {
  let streamMeta: StreamMeta | null = null;
  if (isStreamRead) {
    streamMeta = await getStreamMeta(env.REGISTRY, doKey);
    if (config?.authorizeRead && !streamMeta?.public) {
      const readAuth = await config.authorizeRead(request, doKey, env, timing);
      if (!readAuth.ok) return wrapAuthError(readAuth, corsOrigin);
    }
  } else if (config?.authorizeMutation) {
    const mutAuth = await config.authorizeMutation(request, doKey, env, timing);
    if (!mutAuth.ok) return wrapAuthError(mutAuth, corsOrigin);
  }
  return { streamMeta };
}
// #endregion docs-authorize-request

// ============================================================================
// Edge Cache Lookup
// ============================================================================

/**
 * Look up a cached response from the edge cache, handling ETag revalidation.
 * Returns a Response on cache hit (or 304), or null on cache miss.
 */
async function lookupEdgeCache(
  request: Request,
  cacheUrl: string,
  corsOrigin: string | null,
  timing: Timing | null,
): Promise<Response | null> {
  const cache = caches.default;
  const doneCache = timing?.start("edge.cache");
  const cached = await cache.match(cacheUrl);
  doneCache?.();

  if (!cached) {
    timing?.record("edge.cache.result", 0, "miss");
    return null;
  }

  // ETag revalidation at the edge
  const ifNoneMatch = request.headers.get("If-None-Match");
  const cachedEtag = cached.headers.get("ETag");
  if (ifNoneMatch && cachedEtag && ifNoneMatch === cachedEtag) {
    const headers304 = new Headers(cached.headers);
    headers304.set("X-Cache", "HIT");
    applyCorsHeaders(headers304, corsOrigin);
    timing?.record("edge.cache.result", 0, "revalidate-304");
    return attachTiming(new Response(null, { status: 304, headers: headers304 }), timing);
  }

  // Cache hit — return cached response
  const responseHeaders = new Headers(cached.headers);
  responseHeaders.set("X-Cache", "HIT");
  applyCorsHeaders(responseHeaders, corsOrigin);
  timing?.record("edge.cache.result", 0, "hit");
  return attachTiming(
    new Response(cached.body, { status: cached.status, headers: responseHeaders }),
    timing,
  );
}

// ============================================================================
// In-flight Coalescing
// ============================================================================

/**
 * Check if another request is already fetching the same URL. If so, wait for
 * its result and return a Response. Returns null if no pending request exists
 * or if the pending request fails (caller should fall through to the DO).
 */
async function tryCoalesceInFlight(
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
    logWarn({ cacheUrl, component: "coalesce" }, "coalesced request failed, falling through to DO", e);
    return null;
  }
}

// ============================================================================
// Stream Creation Metadata
// ============================================================================

/**
 * On successful stream creation (PUT → 201), write metadata to KV for edge
 * lookups. Generates a reader key for auth-required, non-public streams so
 * unauthorized clients can't match cached entries.
 */
function writeStreamCreationMetadata<E extends BaseEnv>(
  url: URL,
  doKey: string,
  config: StreamWorkerConfig<E> | undefined,
  kv: KVNamespace,
  waitUntil: (p: Promise<unknown>) => void,
  wrapped: Response,
): void {
  const isPublic = url.searchParams.get("public") === "true";
  // Generate a reader key for auth-required, non-public streams.
  // The reader key adds an unguessable component to the CDN cache key
  // so unauthorized clients can't match cached entries.
  // Skip when no authorizeRead is configured (no auth = nothing to protect).
  const readerKey = !isPublic && config?.authorizeRead
    ? `rk_${crypto.randomUUID().replace(/-/g, "")}`
    : undefined;
  if (readerKey) {
    wrapped.headers.set(HEADER_STREAM_READER_KEY, readerKey);
  }
  waitUntil(putStreamMetadata(kv, doKey, {
    public: isPublic,
    content_type: wrapped.headers.get("Content-Type") || "application/octet-stream",
    readerKey,
  }));
}

// ============================================================================
// Edge Cache Storage
// ============================================================================

/**
 * Store a cacheable 200 response in the edge cache. Returns true if stored.
 *
 * Caches mid-stream reads (immutable data) and long-poll reads (cursor rotation
 * prevents stale loops, enables request collapsing). Plain GET at-tail responses
 * are NOT cached — data can change as appends arrive, and caching them breaks
 * read-after-write consistency.
 */
function storeInEdgeCache(
  waitUntil: (p: Promise<unknown>) => void,
  cacheUrl: string,
  isLongPoll: boolean,
  streamMeta: StreamMeta | null,
  url: URL,
  wrapped: Response,
): boolean {
  const cc = wrapped.headers.get("Cache-Control") ?? "";
  const atTail = wrapped.headers.get(HEADER_STREAM_UP_TO_DATE) === "true";
  // Don't cache responses at bare URLs for streams with a reader key.
  // Without this guard, an authenticated client without ?rk would populate
  // a cache entry at a guessable URL that anyone could then hit.
  const hasReaderKey = streamMeta?.readerKey;
  const urlHasRk = url.searchParams.has("rk");
  if (!cc.includes("no-store") && (!atTail || isLongPoll) && !(hasReaderKey && !urlHasRk)) {
    waitUntil(caches.default.put(cacheUrl, wrapped.clone()));
    return true;
  }
  return false;
}

// ============================================================================
// In-flight Resolution
// ============================================================================

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
function resolveInFlightWaiters(
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
  resolve({ body: bodyBuffer, status: response.status, statusText: response.statusText, headers: rawHeaders });
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

// ============================================================================
// Factory
// ============================================================================

export function createStreamWorker<E extends BaseEnv = BaseEnv>(
  config?: StreamWorkerConfig<E>,
): ExportedHandler<E> {
  // Deduplicates concurrent cache-miss requests for the same URL within
  // a single Worker isolate. The first request becomes the "winner" and
  // makes the DO round-trip; all others await the same promise.
  // Resolved entries linger for COALESCE_LINGER_MS so that requests
  // arriving just after resolution still get a HIT.
  type AppEnv = { Bindings: E; Variables: { projectConfig: ProjectConfig | null } };

  const inFlight = new Map<string, Promise<InFlightResult>>();

  const app = new Hono<AppEnv>();

  // ================================================================
  // Project Config Lookup Middleware
  // ================================================================
  // Look up project config once and store in context for reuse by CORS and auth.
  // We extract the project ID from the URL path because wildcard middleware
  // cannot access route-specific params (e.g. :project, :projectId).
  app.use("*", async (c, next) => {
    const segments = new URL(c.req.url).pathname.split("/").filter(Boolean);
    // /v1/config/:projectId       → ["v1","config",projectId]
    // /v1/stream/:project/:stream → ["v1","stream",project,stream]
    // /v1/stream/:stream          → ["v1","stream",stream] → _default project
    let projectId: string | undefined;
    if (segments[0] === "v1" && segments[1] === "config" && segments.length === 3) {
      projectId = segments[2];
    } else if (segments[0] === "v1" && segments[1] === "stream" && segments.length >= 3) {
      projectId = parseStreamPath(segments.slice(2).join("/")).projectId;
    }
    if (projectId && PROJECT_ID_PATTERN.test(projectId) && c.env.REGISTRY) {
      const projectConfig = await lookupProjectConfig(c.env.REGISTRY, projectId);
      c.set("projectConfig", projectConfig);
    }
    return next();
  });

  // ================================================================
  // CORS Middleware
  // ================================================================
  app.use("*", async (c, next) => {
    const projectConfig = c.get("projectConfig");
    const corsOrigin = resolveProjectCorsOrigin(projectConfig?.corsOrigins, c.req.header("Origin") ?? null);

    // Handle OPTIONS preflight
    if (c.req.method === "OPTIONS") {
      const headers = new Headers();
      applyCorsHeaders(headers, corsOrigin);
      return new Response(null, { status: 204, headers });
    }

    await next();

    // Apply CORS headers to response
    applyCorsHeaders(c.res.headers, corsOrigin);
  });

  // ================================================================
  // Health Check
  // ================================================================
  app.get("/health", (c) => {
    return c.text("ok", 200, { "Cache-Control": "no-store" });
  });

  // ================================================================
  // Config Routes - JWT Auth Middleware
  // ================================================================
  app.use("/v1/config/:projectId", async (c, next) => {
    if (!c.env.REGISTRY) {
      return errorResponse(500, "REGISTRY not configured");
    }

    const projectId = c.req.param("projectId");
    if (!projectId || !PROJECT_ID_PATTERN.test(projectId)) {
      return errorResponse(400, "invalid project id");
    }

    const result = await checkProjectJwt(c.req.raw, c.get("projectConfig"), projectId, { requiredScope: "manage" });
    if (!result.ok) {
      return errorResponse(result.status, result.error);
    }

    return next();
  });

  // Mount config routes - they already have /v1/config prefix
  app.route("/", configRoutes);

  // ================================================================
  // Stream Routes
  // ================================================================
  const streamHandler = async (c: Context<AppEnv>): Promise<Response> => {
    // #region docs-request-arrives
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const timingEnabled =
      c.env.DEBUG_TIMING === "1" || request.headers.get("X-Debug-Timing") === "1";
    const timing = timingEnabled ? new Timing() : null;

    // #region docs-extract-stream-id
    // Extract project + stream ID from route params.
    // Two-segment route: /v1/stream/:project/:stream
    // Legacy route:      /v1/stream/:stream → _default project
    const projectParam = c.req.param("project");
    const streamParam = c.req.param("stream");
    const rawPath = streamParam ? `${projectParam}/${streamParam}` : projectParam;
    if (!rawPath) {
      return errorResponse(400, "missing project or stream id");
    }
    const { projectId, path: doKey } = parseStreamPath(rawPath);
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      return errorResponse(400, "invalid project id");
    }
    // #endregion docs-extract-stream-id

    // Derive corsOrigin from projectConfig (already looked up in middleware)
    const projectConfig = c.get("projectConfig");
    const corsOrigin = resolveProjectCorsOrigin(projectConfig?.corsOrigins, c.req.header("Origin") ?? null);

    const method = request.method.toUpperCase();
    const isStreamRead = method === "GET" || method === "HEAD";

    // Authorize the request
    const authResult = await authorizeStreamRequest(request, doKey, c.env, config, isStreamRead, corsOrigin, timing);
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
      writeStreamCreationMetadata(url, doKey, config, c.env.REGISTRY, (p) => c.executionCtx.waitUntil(p), wrapped);
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

  // Mount stream routes - support both formats
  app.all("/v1/stream/:project/:stream", streamHandler);
  app.all("/v1/stream/:project", streamHandler); // Legacy: maps to _default project

  // 404 fallback
  app.all("*", (c) => {
    return c.text("not found", 404, { "Cache-Control": "no-store" });
  });

  return {
    fetch: app.fetch,
  };
}
