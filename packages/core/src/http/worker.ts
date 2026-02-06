import { StreamDO } from "./durable_object";
import { Timing, attachTiming } from "../protocol/timing";
import { CACHE_MODE_HEADER, resolveCacheMode, SESSION_ID_HEADER } from "./router";
import { applyCorsHeaders } from "./hono";

export interface Env {
  STREAMS: DurableObjectNamespace;
  AUTH_TOKEN?: string;
  CACHE_MODE?: string;
  READ_JWT_SECRET?: string;
  R2?: R2Bucket;
  ADMIN_DB?: D1Database;
  DEBUG_TIMING?: string;
  METRICS?: AnalyticsEngineDataset;
}

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

type AuthResult =
  | {
      ok: true;
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

async function recordStreamInD1(
  db: D1Database,
  streamId: string,
  contentType: string,
  createdAt: number,
): Promise<void> {
  try {
    await db
      .prepare(
        "INSERT OR IGNORE INTO streams (stream_id, content_type, created_at) VALUES (?, ?, ?)",
      )
      .bind(streamId, contentType, createdAt)
      .run();
  } catch (err) {
    console.error("Failed to record stream in D1:", err);
  }
}

async function deleteStreamFromD1(db: D1Database, streamId: string): Promise<void> {
  try {
    await db
      .prepare("UPDATE streams SET deleted_at = ? WHERE stream_id = ?")
      .bind(Date.now(), streamId)
      .run();
  } catch (err) {
    console.error("Failed to delete stream from D1:", err);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const timingEnabled = env.DEBUG_TIMING === "1" || request.headers.get("X-Debug-Timing") === "1";
    const timing = timingEnabled ? new Timing() : null;

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

    // Record stream creates/deletes to D1 for admin querying
    if (env.ADMIN_DB) {
      if (request.method === "PUT" && response.status === 201) {
        const contentType = response.headers.get("Content-Type") ?? "application/octet-stream";
        ctx.waitUntil(recordStreamInD1(env.ADMIN_DB, streamId, contentType, Date.now()));
      } else if (request.method === "DELETE" && response.status === 204) {
        ctx.waitUntil(deleteStreamFromD1(env.ADMIN_DB, streamId));
      }
    }

    return attachTiming(wrapped, timing);
  },
};

export { StreamDO };
