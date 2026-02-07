import type { Timing } from "../protocol/timing";

// ============================================================================
// Types
// ============================================================================

export type AuthResult = { ok: true } | { ok: false; response: Response };

export type ReadAuthResult =
  | { ok: true }
  | { ok: false; response: Response; authFailed?: boolean };

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

export type ProjectJwtEnv = {
  REGISTRY: KVNamespace;
};

export type ProjectJwtClaims = {
  sub: string;
  scope: "write" | "read";
  exp: number;
  stream_id?: string;
};

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

/**
 * Look up the project config from KV.
 * KV key IS the projectId, value is `{ signingSecret: string }`.
 */
export async function lookupProjectConfig(
  kv: KVNamespace,
  projectId: string,
): Promise<{ signingSecret: string } | null> {
  const value = await kv.get(projectId, "json");
  if (value && typeof value === "object" && "signingSecret" in (value as Record<string, unknown>)) {
    return value as { signingSecret: string };
  }
  return null;
}

/**
 * Decode the JWT payload without verifying the signature.
 * Used to peek at `sub` before we know which secret to verify with.
 */
export function decodeJwtPayloadUnsafe(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payloadJson = new TextDecoder().decode(base64UrlDecode(parts[1]));
    return JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Full HMAC-SHA256 JWT verification.
 * Validates shape: { sub: string, scope: "write"|"read", exp: number, stream_id?: string }
 */
export async function verifyProjectJwt(
  token: string,
  signingSecret: string,
): Promise<ProjectJwtClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  try {
    const headerJson = new TextDecoder().decode(base64UrlDecode(headerPart));
    const header = JSON.parse(headerJson) as { alg?: string; typ?: string };
    if (header.alg !== "HS256") return null;

    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadPart));
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;

    // Validate shape
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    if (payload.scope !== "write" && payload.scope !== "read") return null;
    if (typeof payload.exp !== "number") return null;

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingSecret),
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

    return {
      sub: payload.sub as string,
      scope: payload.scope as "write" | "read",
      exp: payload.exp as number,
      stream_id: typeof payload.stream_id === "string" ? payload.stream_id : undefined,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Per-Project JWT Auth
// ============================================================================

/**
 * Project JWT auth returning `authorizeMutation` and `authorizeRead` callbacks.
 *
 * Both callbacks share core logic:
 * 1. REGISTRY is required — 500 if not bound
 * 2. Extract bearer token → 401 if missing
 * 3. Extract projectId from doKey (split on `/`)
 * 4. lookupProjectConfig → 401 if not found
 * 5. verifyProjectJwt → 401 if invalid
 * 6. Check claims.sub === projectId → 403 if mismatch
 * 7. Check expiry → 401 if expired
 */
export function projectJwtAuth(): {
  authorizeMutation: AuthorizeMutation<ProjectJwtEnv>;
  authorizeRead: AuthorizeRead<ProjectJwtEnv>;
} {
  const authorizeMutation: AuthorizeMutation<ProjectJwtEnv> = async (request, doKey, env, timing) => {
    if (!env.REGISTRY) {
      return { ok: false, response: new Response("REGISTRY not configured", { status: 500 }) };
    }

    const doneAuth = timing?.start("edge.auth");
    try {
      const token = extractBearerToken(request);
      if (!token) {
        return { ok: false, response: new Response("unauthorized", { status: 401 }) };
      }

      const slashIndex = doKey.indexOf("/");
      if (slashIndex === -1) {
        return { ok: false, response: new Response("forbidden", { status: 403 }) };
      }
      const projectId = doKey.substring(0, slashIndex);

      const config = await lookupProjectConfig(env.REGISTRY, projectId);
      if (!config) {
        return { ok: false, response: new Response("unauthorized", { status: 401 }) };
      }

      const claims = await verifyProjectJwt(token, config.signingSecret);
      if (!claims) {
        return { ok: false, response: new Response("unauthorized", { status: 401 }) };
      }

      if (claims.sub !== projectId) {
        return { ok: false, response: new Response("forbidden", { status: 403 }) };
      }

      if (Date.now() >= claims.exp * 1000) {
        return { ok: false, response: new Response("token expired", { status: 401 }) };
      }

      if (claims.scope !== "write") {
        return { ok: false, response: new Response("forbidden", { status: 403 }) };
      }

      return { ok: true };
    } finally {
      doneAuth?.();
    }
  };

  const authorizeRead: AuthorizeRead<ProjectJwtEnv> = async (request, doKey, env, timing) => {
    if (!env.REGISTRY) {
      return { ok: false, response: new Response("REGISTRY not configured", { status: 500 }) };
    }

    const doneAuth = timing?.start("edge.read_auth");
    try {
      const token = extractBearerToken(request);
      if (!token) {
        return { ok: false, response: new Response("unauthorized", { status: 401 }), authFailed: true };
      }

      const slashIndex = doKey.indexOf("/");
      if (slashIndex === -1) {
        return { ok: false, response: new Response("forbidden", { status: 403 }), authFailed: true };
      }
      const projectId = doKey.substring(0, slashIndex);

      const config = await lookupProjectConfig(env.REGISTRY, projectId);
      if (!config) {
        return { ok: false, response: new Response("unauthorized", { status: 401 }), authFailed: true };
      }

      const claims = await verifyProjectJwt(token, config.signingSecret);
      if (!claims) {
        return { ok: false, response: new Response("unauthorized", { status: 401 }), authFailed: true };
      }

      if (claims.sub !== projectId) {
        return { ok: false, response: new Response("forbidden", { status: 403 }), authFailed: true };
      }

      if (Date.now() >= claims.exp * 1000) {
        return { ok: false, response: new Response("token expired", { status: 401 }), authFailed: true };
      }

      // Read auth accepts both "write" and "read" scope
      // If stream_id is present, verify it matches the stream portion of doKey
      if (claims.stream_id) {
        const streamPart = doKey.substring(slashIndex + 1);
        if (claims.stream_id !== streamPart) {
          return { ok: false, response: new Response("forbidden", { status: 403 }), authFailed: true };
        }
      }

      return { ok: true };
    } finally {
      doneAuth?.();
    }
  };

  return { authorizeMutation, authorizeRead };
}
