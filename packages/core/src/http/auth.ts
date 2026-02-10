import { decodeJwt, jwtVerify } from "jose";
import type { Timing } from "../protocol/timing";
import type { ProjectEntry } from "../storage/registry";
import { getProjectEntry } from "../storage/registry";

// ============================================================================
// Types
// ============================================================================

export type AuthResult = { ok: true } | { ok: false; response: Response };

export type ReadAuthResult = AuthResult;

/**
 * Project config shape used for authentication.
 * This is a subset of ProjectEntry from REGISTRY - just the auth-relevant fields.
 */
export type ProjectConfig = Pick<ProjectEntry, "signingSecrets" | "corsOrigins">;

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
  scope: "write" | "read" | "manage";
  exp: number;
  stream_id?: string;
};

// ============================================================================
// JWT Helpers
// ============================================================================

/** Extract the bearer token from the Authorization header, or null if not present. */
export function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/.exec(auth);
  return match ? match[1] : null;
}

/**
 * Look up the project config from KV.
 * Returns just the auth-relevant fields (signingSecrets and corsOrigins).
 */
export async function lookupProjectConfig(
  kv: KVNamespace,
  projectId: string,
): Promise<ProjectConfig | null> {
  const entry = await getProjectEntry(kv, projectId);
  if (!entry) return null;
  return {
    signingSecrets: entry.signingSecrets,
    corsOrigins: entry.corsOrigins,
  };
}

/**
 * Decode the JWT payload without verifying the signature.
 * Used to peek at `sub` before we know which secret to verify with.
 */
export function decodeJwtPayloadUnsafe(token: string): Record<string, unknown> | null {
  try {
    return decodeJwt(token);
  } catch {
    return null;
  }
}

/**
 * Full HMAC-SHA256 JWT verification.
 * Validates shape: { sub: string, scope: "write"|"read"|"manage", exp: number, stream_id?: string }
 */
export async function verifyProjectJwt(
  token: string,
  signingSecret: string,
): Promise<ProjectJwtClaims | null> {
  try {
    const secret = new TextEncoder().encode(signingSecret);
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });

    // Validate shape
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    if (payload.scope !== "write" && payload.scope !== "read" && payload.scope !== "manage") return null;
    if (typeof payload.exp !== "number") return null;

    return {
      sub: payload.sub,
      scope: payload.scope as "write" | "read" | "manage",
      exp: payload.exp,
      stream_id: typeof payload.stream_id === "string" ? payload.stream_id : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Try verifying the JWT against each signing secret in the config.
 * Returns the first successful verification or null if none match.
 */
export async function verifyProjectJwtMultiKey(
  token: string,
  config: ProjectConfig,
): Promise<ProjectJwtClaims | null> {
  for (const secret of config.signingSecrets) {
    const claims = await verifyProjectJwt(token, secret);
    if (claims) return claims;
  }
  return null;
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

      const claims = await verifyProjectJwtMultiKey(token, config);
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

      const claims = await verifyProjectJwtMultiKey(token, config);
      if (!claims) {
        return { ok: false, response: new Response("unauthorized", { status: 401 }) };
      }

      if (claims.sub !== projectId) {
        return { ok: false, response: new Response("forbidden", { status: 403 }) };
      }

      if (Date.now() >= claims.exp * 1000) {
        return { ok: false, response: new Response("token expired", { status: 401 }) };
      }

      // Read auth accepts both "write" and "read" scope
      // If stream_id is present, verify it matches the stream portion of doKey
      if (claims.stream_id) {
        const streamPart = doKey.substring(slashIndex + 1);
        if (claims.stream_id !== streamPart) {
          return { ok: false, response: new Response("forbidden", { status: 403 }) };
        }
      }

      return { ok: true };
    } finally {
      doneAuth?.();
    }
  };

  return { authorizeMutation, authorizeRead };
}
