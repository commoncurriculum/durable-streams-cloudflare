import {
  HEADER_SSE_DATA_ENCODING,
  HEADER_STREAM_READER_KEY,
  HEADER_STREAM_UP_TO_DATE,
} from "../protocol/headers";
import { Timing, attachTiming } from "../protocol/timing";
import { logError, logWarn } from "../log";
import { applyCorsHeaders } from "./hono";
import type { AuthorizeMutation, AuthorizeRead, ProjectConfig } from "./auth";
import { lookupProjectConfig } from "./auth";
import type { StreamDO } from "./durable_object";
import { buildSseDataEvent } from "./handlers/realtime";
import type { WsDataMessage, WsControlMessage } from "./handlers/realtime";


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

const STREAM_PATH_RE = /^\/v1\/([^/]+)\/stream\/(.+)$/;
const LEGACY_STREAM_PATH_RE = /^\/v1\/stream\/(.+)$/;
export const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_PROJECT_ID = "_default";

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

/**
 * Look up the CORS origin for a project by extracting projectId from a URL path
 * and reading the project config from KV.
 */
async function lookupCorsOriginForPath(
  kv: KVNamespace | undefined,
  pathname: string,
  requestOrigin: string | null,
): Promise<string | null> {
  if (!kv) return null;
  const pathMatch = STREAM_PATH_RE.exec(pathname);
  const legacyMatch = !pathMatch ? LEGACY_STREAM_PATH_RE.exec(pathname) : null;
  if (!pathMatch && !legacyMatch) return null;
  let projectId: string;
  try {
    projectId = pathMatch ? decodeURIComponent(pathMatch[1]) : DEFAULT_PROJECT_ID;
  } catch {
    return null;
  }
  if (!projectId || !PROJECT_ID_PATTERN.test(projectId)) return null;
  const config = await lookupProjectConfig(kv, projectId);
  return resolveProjectCorsOrigin(config?.corsOrigins, requestOrigin);
}

function wrapAuthError(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  applyCorsHeaders(headers, origin);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type StreamMeta = { public: boolean; readerKey?: string };

/**
 * Look up stream metadata from KV.
 * KV key: `projectId/streamId`, value: JSON with `{ public, content_type, created_at, readerKey? }`.
 * Returns null when the KV binding is missing or the key doesn't exist.
 */
async function getStreamMeta(kv: KVNamespace | undefined, doKey: string): Promise<StreamMeta | null> {
  if (!kv) return null;
  const value = await kv.get(doKey, "json");
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    public: record.public === true,
    readerKey: typeof record.readerKey === "string" ? record.readerKey : undefined,
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
  const inFlight = new Map<string, Promise<InFlightResult>>();

  return {
    // #region docs-request-arrives
    async fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      const timingEnabled =
        env.DEBUG_TIMING === "1" || request.headers.get("X-Debug-Timing") === "1";
      const timing = timingEnabled ? new Timing() : null;

      // Non-project routes: no CORS headers (secure default)
      if (request.method === "OPTIONS") {
        const corsOrigin = await lookupCorsOriginForPath(
          env.REGISTRY,
          url.pathname,
          request.headers.get("Origin"),
        );
        const headers = new Headers();
        applyCorsHeaders(headers, corsOrigin);
        return new Response(null, { status: 204, headers });
      }

      if (url.pathname === "/health") {
        return new Response("ok", { status: 200, headers: { "Cache-Control": "no-store" } });
      }

      // #region docs-extract-stream-id
      // Parse project + stream ID from /v1/:project/stream/:id
      // Also supports legacy /v1/stream/:id format (maps to _default project)
      const pathMatch = STREAM_PATH_RE.exec(url.pathname);
      const legacyMatch = !pathMatch ? LEGACY_STREAM_PATH_RE.exec(url.pathname) : null;
      if (!pathMatch && !legacyMatch) {
        return new Response("not found", { status: 404, headers: { "Cache-Control": "no-store" } });
      }

      let projectId: string;
      let streamId: string;
      try {
        if (pathMatch) {
          projectId = decodeURIComponent(pathMatch[1]);
          streamId = decodeURIComponent(pathMatch[2]);
        } else {
          projectId = DEFAULT_PROJECT_ID;
          streamId = decodeURIComponent(legacyMatch![1]);
        }
      } catch (err) {
        return new Response(
          err instanceof Error ? err.message : "malformed stream id",
          { status: 400, headers: { "Cache-Control": "no-store" } },
        );
      }
      if (!projectId || !streamId) {
        return new Response("missing project or stream id", { status: 400, headers: { "Cache-Control": "no-store" } });
      }
      if (!PROJECT_ID_PATTERN.test(projectId)) {
        return new Response("invalid project id", { status: 400, headers: { "Cache-Control": "no-store" } });
      }

      // DO key combines project + stream for isolation
      const doKey = `${projectId}/${streamId}`;
      // #endregion docs-extract-stream-id

      // Resolve per-project CORS from KV config.
      // Unconfigured projects (no corsOrigins in KV): no CORS headers.
      let projectConfig: ProjectConfig | null = null;
      if (env.REGISTRY) {
        projectConfig = await lookupProjectConfig(env.REGISTRY, projectId);
      }
      const corsOrigin = resolveProjectCorsOrigin(
        projectConfig?.corsOrigins,
        request.headers.get("Origin"),
      );

      const method = request.method.toUpperCase();
      const isStreamRead = method === "GET" || method === "HEAD";

      // #region docs-authorize-request
      // Auth callbacks receive doKey (projectId/streamId) so they can check project scope.
      // For reads, public streams skip auth entirely (checked via KV before auth).
      // Stream metadata (including readerKey) is used later for HEAD headers and cache guards.
      let streamMeta: StreamMeta | null = null;
      if (isStreamRead) {
        streamMeta = await getStreamMeta(env.REGISTRY, doKey);
        if (config?.authorizeRead && !streamMeta?.public) {
          const readAuth = await config.authorizeRead(request, doKey, env, timing);
          if (!readAuth.ok) return wrapAuthError(readAuth.response, corsOrigin);
        }
      } else if (!isStreamRead && config?.authorizeMutation) {
        const mutAuth = await config.authorizeMutation(request, doKey, env, timing);
        if (!mutAuth.ok) return wrapAuthError(mutAuth.response, corsOrigin);
      }
      // #endregion docs-authorize-request

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
        const cache = caches.default;
        const doneCache = timing?.start("edge.cache");
        const cached = await cache.match(cacheUrl!);
        doneCache?.();

        if (cached) {
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
        timing?.record("edge.cache.result", 0, "miss");
        cacheStatus = "MISS";
      }

      // ================================================================
      // In-flight coalescing: deduplicate concurrent cache misses
      // ================================================================
      if (cacheStatus === "MISS" && cacheUrl) {
        const pending = inFlight.get(cacheUrl);
        if (pending) {
          // Another request is already fetching this URL — wait for it
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
          }
        }
      }

      // #region docs-route-to-do
      const stub = env.STREAMS.getByName(doKey);

      // ================================================================
      // SSE via internal WebSocket bridge
      // ================================================================
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
      if (method === "PUT" && wrapped.status === 201 && env.REGISTRY) {
        const isPublic = url.searchParams.get("public") === "true";
        // Generate a reader key for auth-required, non-public streams.
        // The reader key adds an unguessable component to the CDN cache key
        // so unauthorized clients can't match cached entries.
        // Skip when no authorizeRead is configured (no auth = nothing to protect).
        const readerKey = !isPublic && config?.authorizeRead
          ? `rk_${crypto.randomUUID().replace(/-/g, "")}`
          : undefined;
        const kvMeta: Record<string, unknown> = {
          public: isPublic,
          content_type: wrapped.headers.get("Content-Type") || "application/octet-stream",
          created_at: Date.now(),
        };
        if (readerKey) {
          kvMeta.readerKey = readerKey;
          wrapped.headers.set(HEADER_STREAM_READER_KEY, readerKey);
        }
        ctx.waitUntil(env.REGISTRY.put(doKey, JSON.stringify(kvMeta)));
      }

      // ================================================================
      // Edge cache: store cacheable 200 responses
      // ================================================================
      // Cache mid-stream reads (immutable data) and long-poll reads
      // (cursor rotation prevents stale loops, enables request collapsing).
      // Plain GET at-tail responses are NOT cached — data can change as
      // appends arrive, and caching them breaks read-after-write consistency.
      // 204 timeouts are excluded by the status check.
      let storedInCache = false;
      if (cacheable && wrapped.status === 200) {
        const cc = wrapped.headers.get("Cache-Control") ?? "";
        const atTail = wrapped.headers.get(HEADER_STREAM_UP_TO_DATE) === "true";
        // Don't cache responses at bare URLs for streams with a reader key.
        // Without this guard, an authenticated client without ?rk would populate
        // a cache entry at a guessable URL that anyone could then hit.
        const hasReaderKey = streamMeta?.readerKey;
        const urlHasRk = url.searchParams.has("rk");
        if (!cc.includes("no-store") && (!atTail || isLongPoll) && !(hasReaderKey && !urlHasRk)) {
          ctx.waitUntil(caches.default.put(cacheUrl!, wrapped.clone()));
          storedInCache = true;
        }
      }

      // Resolve the in-flight promise so coalesced waiters get the result.
      // Headers are captured from the DO response (before CORS) so each
      // waiter can apply its own CORS headers.
      if (resolveInFlight && cacheUrl) {
        const rawHeaders: [string, string][] = [];
        for (const [k, v] of response.headers) {
          rawHeaders.push([k, v]);
        }
        resolveInFlight({ body: bodyBuffer, status: response.status, statusText: response.statusText, headers: rawHeaders });
        if (storedInCache) {
          // Linger so requests arriving just after resolution still find
          // the resolved promise (covers the gap before cache.put completes).
          const lingerKey = cacheUrl;
          const lingerPromise = inFlight.get(lingerKey);
          setTimeout(() => {
            if (inFlight.get(lingerKey) === lingerPromise) {
              inFlight.delete(lingerKey);
            }
          }, COALESCE_LINGER_MS);
        } else {
          // Response was NOT cached (e.g., at-tail plain GET, 404, 204).
          // Delete immediately — lingering would serve stale data when
          // the stream's tail moves on the next append.
          inFlight.delete(cacheUrl);
        }
      }

      // Set X-Cache header on cacheable responses so cache behavior
      // is observable by tests and operators in any environment.
      if (cacheStatus) {
        wrapped.headers.set("X-Cache", cacheStatus);
      }

      return attachTiming(wrapped, timing);
    },
    // #endregion docs-request-arrives
  };
}
