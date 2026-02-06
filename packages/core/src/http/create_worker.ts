import { Timing, attachTiming } from "../protocol/timing";
import { resolveCacheMode } from "./router";
import { applyCorsHeaders } from "./hono";
import type { AuthorizeMutation, AuthorizeRead } from "./auth";
import type { StreamDO } from "./durable_object";

// ============================================================================
// Types
// ============================================================================

export type BaseEnv = {
  STREAMS: DurableObjectNamespace<StreamDO>;
  AUTH_TOKEN?: string;
  CACHE_MODE?: string;
  READ_JWT_SECRET?: string;
  R2?: R2Bucket;
  DEBUG_TIMING?: string;
  METRICS?: AnalyticsEngineDataset;
};

export type StreamWorkerConfig<E extends BaseEnv = BaseEnv> = {
  authorizeMutation?: AuthorizeMutation<E>;
  authorizeRead?: AuthorizeRead<E>;
};

// ============================================================================
// Internal Helpers
// ============================================================================

const STREAM_PREFIX = "/v1/stream/";

function corsError(status: number, message: string): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  applyCorsHeaders(headers);
  return new Response(message, { status, headers });
}

function shouldUseCache(request: Request, url: URL): boolean {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  if (url.searchParams.get("live") === "sse") return false;
  if (request.headers.has("If-None-Match")) return false;
  return true;
}

function parseMaxAge(cacheControl: string): number | null {
  const match = cacheControl.match(/max-age=(\d+)/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function isCacheableResponse(response: Response): boolean {
  if (![200, 204].includes(response.status)) return false;
  const cacheControl = response.headers.get("Cache-Control");
  if (!cacheControl) return false;
  const lower = cacheControl.toLowerCase();
  if (lower.includes("no-store") || lower.includes("private")) return false;
  const maxAge = parseMaxAge(lower);
  return maxAge !== null && maxAge > 0;
}

function buildCacheKey(url: URL, method: string): Request {
  return new Request(url.toString(), {
    method,
    cf: { cacheKey: url.toString() },
  });
}

function wrapAuthError(response: Response): Response {
  const headers = new Headers(response.headers);
  applyCorsHeaders(headers);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ============================================================================
// Factory
// ============================================================================

export function createStreamWorker<E extends BaseEnv = BaseEnv>(
  config?: StreamWorkerConfig<E>,
): ExportedHandler<E> {
  return {
    // #region docs-request-arrives
    async fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      const timingEnabled =
        env.DEBUG_TIMING === "1" || request.headers.get("X-Debug-Timing") === "1";
      const timing = timingEnabled ? new Timing() : null;

      if (request.method === "OPTIONS") {
        const headers = new Headers();
        applyCorsHeaders(headers);
        return new Response(null, { status: 204, headers });
      }

      // Parse stream ID early so auth callbacks have access to it
      if (!url.pathname.startsWith(STREAM_PREFIX)) {
        return corsError(404, "not found");
      }

      // #region docs-extract-stream-id
      let streamId: string;
      try {
        streamId = decodeURIComponent(url.pathname.slice(STREAM_PREFIX.length));
      } catch {
        return corsError(400, "malformed stream id");
      }
      if (!streamId) {
        return corsError(400, "missing stream id");
      }
      // #endregion docs-extract-stream-id

      const method = request.method.toUpperCase();
      const isStreamRead = method === "GET" || method === "HEAD";
      let sessionId: string | null = null;

      // #region docs-authorize-request
      if (isStreamRead && config?.authorizeRead) {
        const readAuth = await config.authorizeRead(request, streamId, env, timing);
        if (!readAuth.ok) return wrapAuthError(readAuth.response);
        sessionId = readAuth.sessionId;
      } else if (!isStreamRead && config?.authorizeMutation) {
        const mutAuth = await config.authorizeMutation(request, streamId, env, timing);
        if (!mutAuth.ok) return wrapAuthError(mutAuth.response);
      }
      // #endregion docs-authorize-request

      const cacheMode = resolveCacheMode({
        envMode: env.CACHE_MODE,
        authMode: undefined,
      });

      const cacheable = cacheMode === "shared" && shouldUseCache(request, url);
      const cache = caches.default;
      const cacheKey = buildCacheKey(url, method);

      if (cacheable) {
        const doneMatch = timing?.start("edge.cache.match");
        const cached = await cache.match(cacheKey);
        doneMatch?.();
        if (cached) {
          timing?.record("edge.cache", 0, "hit");
          return attachTiming(cached, timing);
        }
        timing?.record("edge.cache", 0, "miss");
      }

      // #region docs-route-to-do
      const stub = env.STREAMS.getByName(streamId);

      const doneOrigin = timing?.start("edge.origin");
      const response = await stub.routeStreamRequest(
        streamId,
        cacheMode,
        sessionId,
        timingEnabled,
        request,
      );
      doneOrigin?.();
      // #endregion docs-route-to-do
      const responseHeaders = new Headers(response.headers);
      applyCorsHeaders(responseHeaders);
      const wrapped = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });

      if (cacheable && isCacheableResponse(wrapped)) {
        ctx.waitUntil(cache.put(cacheKey, wrapped.clone()));
      }

      return attachTiming(wrapped, timing);
    },
    // #endregion docs-request-arrives
  };
}
