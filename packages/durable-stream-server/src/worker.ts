import { StreamDO } from "./stream_do";
import { appendEnvelopeToSession, type FanOutQueueMessage } from "./do/fanout";
import { Timing, attachTiming } from "./protocol/timing";
import { CACHE_MODE_HEADER, type CacheMode, resolveCacheMode } from "./http/cache_mode";
import { SESSION_ID_HEADER } from "./http/read_auth";
import { createEdgeApp } from "./hono/app";
import { applyCorsHeaders } from "./hono/middleware/cors";

export interface Env {
  STREAMS: DurableObjectNamespace;
  FANOUT_QUEUE?: Queue;
  AUTH_TOKEN?: string;
  CACHE_MODE?: string;
  READ_JWT_SECRET?: string;
  SESSION_TTL_SECONDS?: string;
  R2?: R2Bucket;
  ADMIN_DB?: D1Database;
  DEBUG_TIMING?: string;
  ASSETS?: Fetcher;
  METRICS?: AnalyticsEngineDataset;
  CF_ACCOUNT_ID?: string;
  METRICS_API_TOKEN?: string;
}

const edgeApp = createEdgeApp();

const STREAM_PREFIX = "/v1/stream/";
const API_PREFIX = "/api";
const ADMIN_PREFIX = "/admin";
const SUBSCRIPTIONS_PREFIX = "/v1/subscriptions";
const SESSIONS_PREFIX = "/v1/sessions";
const REGISTRY_STREAM = "__registry__";
const FANOUT_RETRY_MAX_ATTEMPTS = 5;
const FANOUT_RETRY_BASE_SECONDS = 5;
const FANOUT_RETRY_MAX_SECONDS = 900;

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

type ReadAuthResult = { ok: true; sessionId: string } | { ok: false; response: Response };

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/.exec(auth);
  return match ? match[1] : null;
}

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function verifySessionJwt(
  token: string,
  secret: string,
): Promise<{ sessionId: string; exp: number } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  try {
    const headerJson = new TextDecoder().decode(base64UrlDecode(headerPart));
    const header = JSON.parse(headerJson) as { alg?: string; typ?: string };
    if (header.alg !== "HS256") return null;
    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadPart));
    const payload = JSON.parse(payloadJson) as { session_id?: string; exp?: number };
    if (typeof payload.session_id !== "string" || payload.session_id.length === 0) return null;
    if (typeof payload.exp !== "number") return null;

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlDecode(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    if (!ok) return null;
    return { sessionId: payload.session_id, exp: payload.exp };
  } catch {
    return null;
  }
}

async function authorizeRead(
  request: Request,
  secret: string,
  timing: Timing | null,
): Promise<ReadAuthResult> {
  const doneAuth = timing?.start("edge.read_auth");
  const token = extractBearerToken(request);
  doneAuth?.();
  if (!token) return { ok: false, response: new Response("unauthorized", { status: 401 }) };
  const claims = await verifySessionJwt(token, secret);
  if (!claims) return { ok: false, response: new Response("unauthorized", { status: 401 }) };
  if (Date.now() >= claims.exp * 1000) {
    return { ok: false, response: new Response("token expired", { status: 401 }) };
  }
  return { ok: true, sessionId: claims.sessionId };
}

async function recordRegistryEvent(
  streams: DurableObjectNamespace,
  event: {
    type: "stream";
    key: string;
    value?: { path: string; contentType: string; createdAt: number };
    headers: { operation: "insert" | "delete" };
  },
): Promise<void> {
  const id = streams.idFromName(REGISTRY_STREAM);
  const stub = streams.get(id);
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Stream-Id": REGISTRY_STREAM,
  });

  try {
    // Ensure registry stream exists
    const putResponse = await stub.fetch(
      new Request("https://internal/", {
        method: "PUT",
        headers,
      }),
    );
    if (!putResponse.ok && putResponse.status !== 200) {
      console.error(`Registry PUT failed: ${putResponse.status} ${await putResponse.text()}`);
      return;
    }

    // Append the event
    const postResponse = await stub.fetch(
      new Request("https://internal/", {
        method: "POST",
        headers,
        body: JSON.stringify(event),
      }),
    );
    if (!postResponse.ok) {
      console.error(`Registry POST failed: ${postResponse.status} ${await postResponse.text()}`);
    }
  } catch (err) {
    console.error("Registry event failed:", err);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const timingEnabled = env.DEBUG_TIMING === "1" || request.headers.get("X-Debug-Timing") === "1";
    const timing = timingEnabled ? new Timing() : null;

    // API routes go to Hono (/api/*)
    if (url.pathname.startsWith(`${API_PREFIX}/`) || url.pathname === API_PREFIX) {
      return edgeApp.fetch(request, env, ctx);
    }

    // Admin UI static assets and SPA routes - serve from ASSETS binding (/admin/*)
    if (url.pathname.startsWith(ADMIN_PREFIX) && env.ASSETS) {
      // Strip /admin prefix - ASSETS expects paths relative to dist/admin-ui
      const assetPath = url.pathname.slice(ADMIN_PREFIX.length) || "/";
      const assetUrl = new URL(assetPath, url.origin);
      assetUrl.search = url.search;
      const assetResponse = await env.ASSETS.fetch(new Request(assetUrl, request));

      // SPA fallback: if asset not found, serve index.html for client-side routing
      if (assetResponse.status === 404 && !assetPath.includes(".")) {
        const indexUrl = new URL("/", url.origin);
        return env.ASSETS.fetch(new Request(indexUrl, request));
      }

      return assetResponse;
    }

    // Other Hono routes (subscriptions, sessions)
    if (
      url.pathname === SUBSCRIPTIONS_PREFIX ||
      url.pathname.startsWith(`${SUBSCRIPTIONS_PREFIX}/`) ||
      url.pathname === SESSIONS_PREFIX
    ) {
      return edgeApp.fetch(request, env, ctx);
    }

    if (request.method === "OPTIONS") {
      const headers = new Headers();
      applyCorsHeaders(headers);
      return new Response(null, { status: 204, headers });
    }

    const method = request.method.toUpperCase();
    const isStreamRead =
      url.pathname.startsWith(STREAM_PREFIX) && (method === "GET" || method === "HEAD");
    let sessionId: string | null = null;

    if (isStreamRead && env.READ_JWT_SECRET) {
      const readAuth = await authorizeRead(request, env.READ_JWT_SECRET, timing);
      if (!readAuth.ok) {
        const headers = new Headers(readAuth.response.headers);
        applyCorsHeaders(headers);
        if (!headers.has("Cache-Control")) {
          headers.set("Cache-Control", "no-store");
        }
        return new Response(readAuth.response.body, {
          status: readAuth.response.status,
          statusText: readAuth.response.statusText,
          headers,
        });
      }
      sessionId = readAuth.sessionId;
    } else {
      const authResult = authorizeRequest(request, env, timing);
      if (!authResult.ok) {
        const headers = new Headers(authResult.response.headers);
        applyCorsHeaders(headers);
        if (!headers.has("Cache-Control")) {
          headers.set("Cache-Control", "no-store");
        }
        return new Response(authResult.response.body, {
          status: authResult.response.status,
          statusText: authResult.response.statusText,
          headers,
        });
      }
    }

    const cacheMode = resolveCacheMode({
      envMode: env.CACHE_MODE,
      authMode: undefined,
    });

    if (!url.pathname.startsWith(STREAM_PREFIX)) {
      return corsError(404, "not found");
    }

    const streamId = decodeURIComponent(url.pathname.slice(STREAM_PREFIX.length));
    if (!streamId) {
      return corsError(400, "missing stream id");
    }

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
    if (sessionId) {
      headers.set(SESSION_ID_HEADER, sessionId);
    }
    if (timingEnabled && !headers.has("X-Debug-Timing")) {
      headers.set("X-Debug-Timing", "1");
    }

    const upstreamReq = new Request(request, { headers });
    const doneOrigin = timing?.start("edge.origin");
    const response = await stub.fetch(upstreamReq);
    doneOrigin?.();
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

    if (streamId !== REGISTRY_STREAM) {
      if (request.method === "PUT" && response.status === 201) {
        const contentType = response.headers.get("Content-Type") ?? "application/octet-stream";
        ctx.waitUntil(
          recordRegistryEvent(env.STREAMS, {
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
          recordRegistryEvent(env.STREAMS, {
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
        const response = await appendEnvelopeToSession(
          env.STREAMS,
          sessionId,
          envelope as FanOutQueueMessage["envelope"],
        );
        if (response.ok || response.status === 404 || response.status === 410) {
          message.ack();
          continue;
        }
        if (message.attempts >= FANOUT_RETRY_MAX_ATTEMPTS) {
          message.ack();
          continue;
        }
        message.retry({ delaySeconds: computeRetryDelay(message.attempts) });
      } catch {
        if (message.attempts >= FANOUT_RETRY_MAX_ATTEMPTS) {
          message.ack();
        } else {
          message.retry({ delaySeconds: computeRetryDelay(message.attempts) });
        }
      }
    }
  },
};

export { StreamDO };

function computeRetryDelay(attempts: number): number {
  const delay = FANOUT_RETRY_BASE_SECONDS * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(delay, FANOUT_RETRY_MAX_SECONDS);
}
