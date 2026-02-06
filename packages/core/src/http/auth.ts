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
// Project Key Types
// ============================================================================

export type ProjectKeyEnv = {
  AUTH_TOKEN?: string;
  PROJECT_KEYS?: KVNamespace;
};

// ============================================================================
// Project Key Helpers
// ============================================================================

async function lookupProjectKey(
  env: ProjectKeyEnv,
  token: string,
): Promise<{ project: string } | null> {
  if (!env.PROJECT_KEYS) return null;
  const value = await env.PROJECT_KEYS.get(token, "json");
  if (value && typeof value === "object" && "project" in (value as Record<string, unknown>)) {
    return value as { project: string };
  }
  return null;
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

// ============================================================================
// Project Key Auth Strategies
// ============================================================================

/**
 * Project key auth for mutations.
 * Priority chain:
 * 1. No auth configured → allow all
 * 2. Bearer matches AUTH_TOKEN → allow (superuser)
 * 3. Bearer found in PROJECT_KEYS KV → allow if project matches URL param, else 403
 * 4. Otherwise → 401
 */
export function projectKeyMutationAuth(): AuthorizeMutation<ProjectKeyEnv> {
  return async (request, _streamId, env, timing) => {
    if (!env.AUTH_TOKEN && !env.PROJECT_KEYS) return { ok: true };

    const doneAuth = timing?.start("edge.auth");
    const token = extractBearerToken(request);
    doneAuth?.();

    if (!token) {
      return { ok: false, response: new Response("unauthorized", { status: 401 }) };
    }

    // Superuser: AUTH_TOKEN bypasses project check
    if (env.AUTH_TOKEN && token === env.AUTH_TOKEN) {
      return { ok: true };
    }

    // Project key lookup
    const keyData = await lookupProjectKey(env, token);
    if (!keyData) {
      return { ok: false, response: new Response("unauthorized", { status: 401 }) };
    }

    // Project match check — projectId is embedded in the streamId as "projectId/streamId"
    // The caller passes the full "projectId/actualStreamId" as streamId
    // We extract the project prefix
    const slashIndex = _streamId.indexOf("/");
    if (slashIndex === -1) {
      return { ok: false, response: new Response("forbidden", { status: 403 }) };
    }
    const urlProject = _streamId.substring(0, slashIndex);
    if (keyData.project !== urlProject) {
      return { ok: false, response: new Response("forbidden", { status: 403 }) };
    }

    return { ok: true };
  };
}

/**
 * Project key auth for reads.
 * Same priority chain as mutation auth, but also checks JWT first.
 * 1. JWT valid → allow (existing browser token flow)
 * 2. No auth configured → allow all
 * 3. Bearer matches AUTH_TOKEN → allow (superuser)
 * 4. Bearer found in PROJECT_KEYS KV → allow if project matches, else 403
 * 5. Otherwise → 401
 */
export function projectKeyReadAuth(): AuthorizeRead<ProjectKeyEnv & { READ_JWT_SECRET?: string }> {
  return async (request, streamId, env, timing) => {
    // Try JWT first (existing flow for browser read tokens)
    if (env.READ_JWT_SECRET) {
      const token = extractBearerToken(request);
      if (token) {
        const claims = await verifyStreamJwt(token, env.READ_JWT_SECRET);
        if (claims && Date.now() < claims.exp * 1000 && streamId === claims.streamId) {
          return { ok: true, streamId: claims.streamId };
        }
        // JWT failed — fall through to project key auth
      }
    }

    // No auth configured → allow all
    if (!env.AUTH_TOKEN && !env.PROJECT_KEYS) return { ok: true, streamId: "" };

    const doneAuth = timing?.start("edge.read_auth");
    const token = extractBearerToken(request);
    doneAuth?.();

    if (!token) {
      return { ok: false, response: new Response("unauthorized", { status: 401 }) };
    }

    // Superuser: AUTH_TOKEN bypasses project check
    if (env.AUTH_TOKEN && token === env.AUTH_TOKEN) {
      return { ok: true, streamId: "" };
    }

    // Project key lookup
    const keyData = await lookupProjectKey(env, token);
    if (!keyData) {
      return { ok: false, response: new Response("unauthorized", { status: 401 }) };
    }

    // Project match check
    const slashIndex = streamId.indexOf("/");
    if (slashIndex === -1) {
      return { ok: false, response: new Response("forbidden", { status: 403 }) };
    }
    const urlProject = streamId.substring(0, slashIndex);
    if (keyData.project !== urlProject) {
      return { ok: false, response: new Response("forbidden", { status: 403 }) };
    }

    return { ok: true, streamId: "" };
  };
}
