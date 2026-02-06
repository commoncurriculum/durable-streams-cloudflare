import type { Timing } from "../protocol/timing";

// ============================================================================
// Types
// ============================================================================

export type AuthResult = { ok: true } | { ok: false; response: Response };

export type ReadAuthResult = { ok: true; streamId: string } | { ok: false; response: Response };

export type AuthorizeMutation<E = unknown> = (
  request: Request,
  streamId: string,
  env: E,
  timing: Timing | null,
) => AuthResult | Promise<AuthResult>;

export type AuthorizeRead<E = unknown> = (
  request: Request,
  streamId: string,
  env: E,
  timing: Timing | null,
) => ReadAuthResult | Promise<ReadAuthResult>;

// ============================================================================
// JWT Helpers
// ============================================================================

export function extractBearerToken(request: Request): string | null {
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

async function verifyStreamJwt(
  token: string,
  secret: string,
): Promise<{ streamId: string; exp: number } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  try {
    const headerJson = new TextDecoder().decode(base64UrlDecode(headerPart));
    const header = JSON.parse(headerJson) as { alg?: string; typ?: string };
    if (header.alg !== "HS256") return null;
    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadPart));
    const payload = JSON.parse(payloadJson) as { stream_id?: string; exp?: number };
    if (typeof payload.stream_id !== "string" || payload.stream_id.length === 0) return null;
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
    return { streamId: payload.stream_id, exp: payload.exp };
  } catch {
    return null;
  }
}

// ============================================================================
// Built-in Strategies
// ============================================================================

/**
 * Bearer token auth for mutations.
 * Checks `env.AUTH_TOKEN` — if not set, all requests are allowed.
 */
export function bearerTokenAuth(): AuthorizeMutation<{ AUTH_TOKEN?: string }> {
  return (request, _streamId, env, timing) => {
    if (!env.AUTH_TOKEN) return { ok: true };
    const doneAuth = timing?.start("edge.auth");
    const auth = request.headers.get("Authorization");
    doneAuth?.();
    if (auth !== `Bearer ${env.AUTH_TOKEN}`) {
      return { ok: false, response: new Response("unauthorized", { status: 401 }) };
    }
    return { ok: true };
  };
}

/**
 * JWT stream auth for reads.
 * Validates HS256 JWT from `env.READ_JWT_SECRET`, checks expiry,
 * and verifies `stream_id` matches the requested stream ID.
 */
// #region docs-authorize-read
export function jwtStreamAuth(): AuthorizeRead<{ READ_JWT_SECRET?: string }> {
  return async (request, streamId, env, timing) => {
    if (!env.READ_JWT_SECRET) return { ok: true, streamId: "" };
    const doneAuth = timing?.start("edge.read_auth");
    const token = extractBearerToken(request);
    doneAuth?.();
    if (!token) return { ok: false, response: new Response("unauthorized", { status: 401 }) };
    const claims = await verifyStreamJwt(token, env.READ_JWT_SECRET);
    if (!claims) return { ok: false, response: new Response("unauthorized", { status: 401 }) };
    if (Date.now() >= claims.exp * 1000) {
      return { ok: false, response: new Response("token expired", { status: 401 }) };
    }

    // Stream-scoped validation: stream_id must match the requested stream
    if (streamId !== claims.streamId) {
      return { ok: false, response: new Response("forbidden", { status: 403 }) };
    }

    return { ok: true, streamId: claims.streamId };
  };
}
// #endregion docs-authorize-read
