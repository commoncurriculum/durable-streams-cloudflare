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
  METRICS?: AnalyticsEngineDataset;
  REGISTRY: KVNamespace;
  CORS_ORIGINS?: string;
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
 * Resolve the CORS origin for a request.
 * - If CORS_ORIGINS is not set or "*", returns "*".
 * - If CORS_ORIGINS is a comma-separated list, returns the request's Origin
 *   header if it matches, otherwise returns the first configured origin.
 */
function resolveCorsOrigin(corsOrigins: string | undefined, requestOrigin: string | null): string {
  if (!corsOrigins || corsOrigins === "*") return "*";
  const origins = corsOrigins.split(",").map((o) => o.trim()).filter(Boolean);
  if (origins.length === 0) return "*";
  if (requestOrigin && origins.includes(requestOrigin)) return requestOrigin;
  return origins[0];
}

function corsError(status: number, message: string, origin?: string): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  applyCorsHeaders(headers, origin);
  return new Response(message, { status, headers });
}

function wrapAuthError(response: Response, origin?: string): Response {
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

/**
 * Check if a stream is marked as public in KV.
 * KV key: `projectId/streamId`, value: JSON with `{ public, content_type, created_at }`.
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
      const corsOrigin = resolveCorsOrigin(env.CORS_ORIGINS, request.headers.get("Origin"));

      if (request.method === "OPTIONS") {
        const headers = new Headers();
        applyCorsHeaders(headers, corsOrigin);
        return new Response(null, { status: 204, headers });
      }

      if (url.pathname === "/health") {
        const headers = new Headers({ "Cache-Control": "no-store" });
        applyCorsHeaders(headers, corsOrigin);
        return new Response("ok", { status: 200, headers });
      }

      // #region docs-extract-stream-id
      // Parse project + stream ID from /v1/:project/stream/:id
      // Also supports legacy /v1/stream/:id format (maps to _default project)
      const pathMatch = STREAM_PATH_RE.exec(url.pathname);
      const legacyMatch = !pathMatch ? LEGACY_STREAM_PATH_RE.exec(url.pathname) : null;
      if (!pathMatch && !legacyMatch) {
        return corsError(404, "not found", corsOrigin);
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
        return corsError(400, "malformed stream id", corsOrigin);
      }
      if (!projectId || !streamId) {
        return corsError(400, "missing project or stream id", corsOrigin);
      }
      if (!PROJECT_ID_PATTERN.test(projectId)) {
        return corsError(400, "invalid project id", corsOrigin);
      }

      // DO key combines project + stream for isolation
      const doKey = `${projectId}/${streamId}`;
      // #endregion docs-extract-stream-id

      const method = request.method.toUpperCase();
      const isStreamRead = method === "GET" || method === "HEAD";

      // #region docs-authorize-request
      // Auth callbacks receive doKey (projectId/streamId) so they can check project scope.
      // For reads, public streams skip auth entirely (checked via KV before auth).
      if (isStreamRead && config?.authorizeRead) {
        const pub = await isStreamPublic(env.REGISTRY, doKey);
        if (!pub) {
          const readAuth = await config.authorizeRead(request, doKey, env, timing);
          if (!readAuth.ok) return wrapAuthError(readAuth.response, corsOrigin);
        }
      } else if (!isStreamRead && config?.authorizeMutation) {
        const mutAuth = await config.authorizeMutation(request, doKey, env, timing);
        if (!mutAuth.ok) return wrapAuthError(mutAuth.response, corsOrigin);
      }
      // #endregion docs-authorize-request

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
      applyCorsHeaders(responseHeaders, corsOrigin);
      const wrapped = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });

      // On successful stream creation, write metadata to KV for edge lookups
      if (method === "PUT" && wrapped.status === 201 && env.REGISTRY) {
        const kvMeta = {
          public: url.searchParams.get("public") === "true",
          content_type: wrapped.headers.get("Content-Type") || "application/octet-stream",
          created_at: Date.now(),
        };
        ctx.waitUntil(env.REGISTRY.put(doKey, JSON.stringify(kvMeta)));
      }

      return attachTiming(wrapped, timing);
    },
    // #endregion docs-request-arrives
  };
}
