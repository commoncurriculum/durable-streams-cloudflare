import { StreamDO } from "./stream_do";
import { appendEnvelopeToSession, type FanOutQueueMessage } from "./do/fanout";
import { Timing, attachTiming } from "./protocol/timing";
import { CACHE_MODE_HEADER, type CacheMode, resolveCacheMode } from "./http/cache_mode";

export interface Env {
  STREAMS: DurableObjectNamespace;
  FANOUT_QUEUE?: Queue;
  AUTH_TOKEN?: string;
  CACHE_MODE?: string;
  R2?: R2Bucket;
  ADMIN_DB?: D1Database;
  DEBUG_TIMING?: string;
}

const STREAM_PREFIX = "/v1/stream/";
const SUBSCRIPTIONS_PREFIX = "/v1/subscriptions";
const REGISTRY_STREAM = "__registry__";

const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Stream-Seq",
  "Stream-TTL",
  "Stream-Expires-At",
  "Stream-Closed",
  "If-None-Match",
  "Producer-Id",
  "Producer-Epoch",
  "Producer-Seq",
  "Authorization",
];

const CORS_EXPOSE_HEADERS = [
  "Stream-Next-Offset",
  "Stream-Cursor",
  "Stream-Up-To-Date",
  "Stream-Closed",
  "ETag",
  "Location",
  "Producer-Epoch",
  "Producer-Seq",
  "Producer-Expected-Seq",
  "Producer-Received-Seq",
  "Stream-SSE-Data-Encoding",
];

function applyCors(headers: Headers): void {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS.join(", "));
  headers.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS.join(", "));
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

type AuthResult =
  | {
      ok: true;
      cacheMode?: CacheMode;
    }
  | {
      ok: false;
      response: Response;
    };

function authorizeRequest(request: Request, env: Env, timing: Timing | null): AuthResult {
  if (!env.AUTH_TOKEN) return { ok: true };
  const doneAuth = timing?.start("edge.auth");
  const auth = request.headers.get("Authorization");
  doneAuth?.();
  if (auth !== `Bearer ${env.AUTH_TOKEN}`) {
    return { ok: false, response: new Response("unauthorized", { status: 401 }) };
  }
  return { ok: true };
}

async function recordRegistryEvent(
  requestUrl: string,
  authToken: string | undefined,
  event: {
    type: "stream";
    key: string;
    value?: { path: string; contentType: string; createdAt: number };
    headers: { operation: "insert" | "delete" };
  },
): Promise<void> {
  const registryUrl = new URL(`${STREAM_PREFIX}${REGISTRY_STREAM}`, requestUrl);
  const headers = new Headers({ "Content-Type": "application/json" });
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);

  await fetch(
    new Request(registryUrl, {
      method: "PUT",
      headers,
    }),
  );

  await fetch(
    new Request(registryUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(event),
    }),
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const timingEnabled = env.DEBUG_TIMING === "1" || request.headers.get("X-Debug-Timing") === "1";
    const timing = timingEnabled ? new Timing() : null;

    if (request.method === "OPTIONS") {
      const headers = new Headers();
      applyCors(headers);
      return new Response(null, { status: 204, headers });
    }

    const authResult = authorizeRequest(request, env, timing);
    if (!authResult.ok) {
      return authResult.response;
    }
    const cacheMode = resolveCacheMode({
      envMode: env.CACHE_MODE,
      authMode: authResult.cacheMode,
    });

    if (
      url.pathname === SUBSCRIPTIONS_PREFIX ||
      url.pathname.startsWith(`${SUBSCRIPTIONS_PREFIX}/`)
    ) {
      const response = await handleSubscriptionsRequest(request, env, url);
      const headers = new Headers(response.headers);
      applyCors(headers);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    if (!url.pathname.startsWith(STREAM_PREFIX)) {
      return new Response("not found", { status: 404 });
    }

    const streamId = decodeURIComponent(url.pathname.slice(STREAM_PREFIX.length));
    if (!streamId) {
      return new Response("missing stream id", { status: 400 });
    }

    const method = request.method.toUpperCase();
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

    const id = env.STREAMS.idFromName(streamId);
    const stub = env.STREAMS.get(id);

    const headers = new Headers(request.headers);
    headers.set("X-Stream-Id", streamId);
    headers.set(CACHE_MODE_HEADER, cacheMode);
    if (timingEnabled && !headers.has("X-Debug-Timing")) {
      headers.set("X-Debug-Timing", "1");
    }

    const upstreamReq = new Request(request, { headers });
    const doneOrigin = timing?.start("edge.origin");
    const response = await stub.fetch(upstreamReq);
    doneOrigin?.();
    const responseHeaders = new Headers(response.headers);
    applyCors(responseHeaders);
    const wrapped = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

    if (cacheable && isCacheableResponse(wrapped)) {
      ctx.waitUntil(cache.put(cacheKey, wrapped.clone()));
    }

    if (streamId !== REGISTRY_STREAM) {
      if (request.method === "PUT" && response.status === 201) {
        const contentType = response.headers.get("Content-Type") ?? "application/octet-stream";
        ctx.waitUntil(
          recordRegistryEvent(request.url, env.AUTH_TOKEN, {
            type: "stream",
            key: streamId,
            value: {
              path: streamId,
              contentType,
              createdAt: Date.now(),
            },
            headers: { operation: "insert" },
          }),
        );
      } else if (request.method === "DELETE" && response.status === 204) {
        ctx.waitUntil(
          recordRegistryEvent(request.url, env.AUTH_TOKEN, {
            type: "stream",
            key: streamId,
            headers: { operation: "delete" },
          }),
        );
      }
    }

    return attachTiming(wrapped, timing);
  },
  async queue(batch: MessageBatch<FanOutQueueMessage>, env: Env, _ctx: ExecutionContext) {
    for (const message of batch.messages) {
      const body = message.body;
      if (!body || typeof body !== "object") {
        message.ack();
        continue;
      }
      const sessionId = "sessionId" in body ? body.sessionId : null;
      const envelope = "envelope" in body ? body.envelope : null;
      if (typeof sessionId !== "string" || !envelope || typeof envelope !== "object") {
        message.ack();
        continue;
      }
      try {
        await appendEnvelopeToSession(env.STREAMS, sessionId, envelope as FanOutQueueMessage["envelope"]);
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
};

export { StreamDO };

async function handleSubscriptionsRequest(request: Request, env: Env, url: URL): Promise<Response> {
  const method = request.method.toUpperCase();

  if (url.pathname === SUBSCRIPTIONS_PREFIX) {
    if (method !== "POST" && method !== "DELETE") {
      return new Response("method not allowed", { status: 405 });
    }
    const payload = await request.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      return new Response("invalid JSON body", { status: 400 });
    }
    const sessionId =
      "sessionId" in payload && typeof payload.sessionId === "string" ? payload.sessionId : null;
    const streamId =
      "streamId" in payload && typeof payload.streamId === "string" ? payload.streamId : null;
    if (!sessionId || !streamId) {
      return new Response("missing sessionId or streamId", { status: 400 });
    }

    const sessionStreamId = `subscriptions/${sessionId}`;
    return await forwardToSessionDO(env, sessionStreamId, method, {
      sessionId,
      streamId,
    });
  }

  if (url.pathname.startsWith(`${SUBSCRIPTIONS_PREFIX}/`)) {
    if (method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    const sessionId = decodeURIComponent(url.pathname.slice(SUBSCRIPTIONS_PREFIX.length + 1));
    if (!sessionId) return new Response("missing session id", { status: 400 });
    const sessionStreamId = `subscriptions/${sessionId}`;
    return await forwardToSessionDO(env, sessionStreamId, "GET");
  }

  return new Response("not found", { status: 404 });
}

async function forwardToSessionDO(
  env: Env,
  sessionStreamId: string,
  method: string,
  body?: Record<string, string>,
): Promise<Response> {
  const id = env.STREAMS.idFromName(sessionStreamId);
  const stub = env.STREAMS.get(id);
  const headers = new Headers();
  headers.set("X-Stream-Id", sessionStreamId);
  if (body) headers.set("Content-Type", "application/json");

  const url = new URL("https://internal/internal/subscriptions");
  return await stub.fetch(
    new Request(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}
