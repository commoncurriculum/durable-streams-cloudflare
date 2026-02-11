import { decodeJwt, jwtVerify } from "jose";
import type { Timing } from "../protocol/timing";
import type { ProjectEntry } from "../storage/registry";
import { getProjectEntry } from "../storage/registry";
import { parseStreamPath } from "./stream-path";

// ============================================================================
// Types
// ============================================================================

export type AuthResult = { ok: true } | { ok: false; status: number; error: string };

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
) => AuthResult | Promise<AuthResult>;

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
// Shared JWT Auth Check
// ============================================================================

export type JwtAuthResult =
  | { ok: true; claims: ProjectJwtClaims }
  | { ok: false; status: number; error: string };

/**
 * Shared JWT auth for all paths: extract token → verify → check sub → expiry → scope → stream_id.
 * Accepts nullable projectConfig so callers don't need a separate null check.
 */
export async function checkProjectJwt(
  request: Request,
  projectConfig: ProjectConfig | null | undefined,
  projectId: string,
  options?: {
    requiredScope?: string | string[];
    streamId?: string;
  },
): Promise<JwtAuthResult> {
  const token = extractBearerToken(request);
  if (!token) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  if (!projectConfig) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  const claims = await verifyProjectJwtMultiKey(token, projectConfig);
  if (!claims) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  if (claims.sub !== projectId) {
    return { ok: false, status: 403, error: "forbidden" };
  }

  if (Date.now() >= claims.exp * 1000) {
    return { ok: false, status: 401, error: "token expired" };
  }

  if (options?.requiredScope) {
    const scopes = Array.isArray(options.requiredScope) ? options.requiredScope : [options.requiredScope];
    if (!scopes.includes(claims.scope)) {
      return { ok: false, status: 403, error: "forbidden" };
    }
  }

  if (options?.streamId && claims.stream_id && claims.stream_id !== options.streamId) {
    return { ok: false, status: 403, error: "forbidden" };
  }

  return { ok: true, claims };
}

// ============================================================================
// Per-Project JWT Auth
// ============================================================================

/**
 * Project JWT auth returning `authorizeMutation` and `authorizeRead` callbacks.
 *
 * Both callbacks share core logic via `authorize`:
 * 1. REGISTRY is required — 500 if not bound
 * 2. Extract projectId + streamId from doKey (split on `/`)
 * 3. lookupProjectConfig from KV
 * 4. checkProjectJwt — token, signature, sub, expiry, scope, stream_id
 */
export function projectJwtAuth(): {
  authorizeMutation: AuthorizeMutation<ProjectJwtEnv>;
  authorizeRead: AuthorizeRead<ProjectJwtEnv>;
} {
  async function authorize(
    request: Request,
    doKey: string,
    env: ProjectJwtEnv,
    timing: Timing | null,
    timingLabel: string,
    buildOptions: (streamId: string) => { requiredScope?: string | string[]; streamId?: string },
  ): Promise<AuthResult> {
    if (!env.REGISTRY) {
      return { ok: false, status: 500, error: "REGISTRY not configured" };
    }

    const done = timing?.start(timingLabel);
    try {
      const { projectId, streamId } = parseStreamPath(doKey);
      const config = await lookupProjectConfig(env.REGISTRY, projectId);

      const result = await checkProjectJwt(request, config, projectId, buildOptions(streamId));
      if (!result.ok) return result;
      return { ok: true } as const;
    } finally {
      done?.();
    }
  }

  return {
    authorizeMutation: (request, doKey, env, timing) =>
      authorize(request, doKey, env, timing, "edge.auth", () => ({ requiredScope: "write" })),

    authorizeRead: (request, doKey, env, timing) =>
      authorize(request, doKey, env, timing, "edge.read_auth", (streamId) => ({ streamId })),
  };
}
