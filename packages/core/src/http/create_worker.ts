import { Timing, attachTiming } from "../protocol/timing";
import { applyCorsHeaders } from "./hono";
import type { AuthorizeMutation, AuthorizeRead } from "./auth";
import type { StreamDO } from "./durable_object";

// ============================================================================
// Types
// ============================================================================

export type BaseEnv = {
  STREAMS: DurableObjectNamespace<StreamDO>;
  R2?: R2Bucket;
  DEBUG_TIMING?: string;
  DEBUG_TESTING?: string;
  METRICS?: AnalyticsEngineDataset;
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
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_PROJECT_ID = "_default";

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

/**
 * Check if a stream is marked as public in KV.
 * KV key: `projectId/streamId`, value: JSON with `{ public: true }`.
 */
async function isStreamPublic(kv: KVNamespace | undefined, doKey: string): Promise<boolean> {
  if (!kv) return false;
  const value = await kv.get(doKey, "json");
  if (value && typeof value === "object" && (value as Record<string, unknown>).public === true) {
    return true;
  }
  return false;
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

      if (url.pathname === "/health") {
        const headers = new Headers({ "Cache-Control": "no-store" });
        applyCorsHeaders(headers);
        return new Response("ok", { status: 200, headers });
      }

      // #region docs-extract-stream-id
      // Parse project + stream ID from /v1/:project/stream/:id
      // Also supports legacy /v1/stream/:id format (maps to _default project)
      const pathMatch = STREAM_PATH_RE.exec(url.pathname);
      const legacyMatch = !pathMatch ? LEGACY_STREAM_PATH_RE.exec(url.pathname) : null;
      if (!pathMatch && !legacyMatch) {
        return corsError(404, "not found");
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
      } catch {
        return corsError(400, "malformed stream id");
      }
      if (!projectId || !streamId) {
        return corsError(400, "missing project or stream id");
      }
      if (!PROJECT_ID_PATTERN.test(projectId)) {
        return corsError(400, "invalid project id");
      }

      // DO key combines project + stream for isolation
      const doKey = `${projectId}/${streamId}`;
      // #endregion docs-extract-stream-id

      const method = request.method.toUpperCase();
      const isStreamRead = method === "GET" || method === "HEAD";

      // #region docs-authorize-request
      // Auth callbacks receive doKey (projectId/streamId) so they can check project scope
      if (isStreamRead && config?.authorizeRead && env.DEBUG_TESTING !== "1") {
        const readAuth = await config.authorizeRead(request, doKey, env, timing);
        if (!readAuth.ok) {
          // On auth failure for reads, check if stream is public
          if (readAuth.authFailed && env.REGISTRY) {
            const pub = await isStreamPublic(env.REGISTRY, doKey);
            if (!pub) {
              return wrapAuthError(readAuth.response);
            }
          } else {
            return wrapAuthError(readAuth.response);
          }
        }
      } else if (!isStreamRead && config?.authorizeMutation && env.DEBUG_TESTING !== "1") {
        const mutAuth = await config.authorizeMutation(request, doKey, env, timing);
        if (!mutAuth.ok) return wrapAuthError(mutAuth.response);
      }
      // #endregion docs-authorize-request

      const cacheable = shouldUseCache(request, url);
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
      const stub = env.STREAMS.getByName(doKey);

      const doneOrigin = timing?.start("edge.origin");
      const response = await stub.routeStreamRequest(
        doKey,
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

      // On successful PUT with X-Stream-Public: true, write public flag to KV
      if (method === "PUT" && wrapped.status === 201 && request.headers.get("X-Stream-Public") === "true" && env.REGISTRY) {
        ctx.waitUntil(env.REGISTRY.put(doKey, JSON.stringify({ public: true })));
      }

      return attachTiming(wrapped, timing);
    },
    // #endregion docs-request-arrives
  };
}
