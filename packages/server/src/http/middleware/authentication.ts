import { type } from "arktype";
import { verify } from "hono/jwt";
import type { ProjectEntry } from "../../storage/registry";
import { getProjectEntry } from "../../storage/registry";

// ============================================================================
// Schemas (ArkType validation)
// ============================================================================

const jwtClaimsSchema = type({
  sub: "string > 0",
  scope: "'write' | 'read' | 'manage'",
  exp: "number",
  "stream_id?": "string",
});

// ============================================================================
// Types
// ============================================================================

/**
 * Project config shape used for authentication.
 * This is a subset of ProjectEntry from REGISTRY - just the auth-relevant fields.
 */
export type ProjectConfig = Pick<ProjectEntry, "signingSecrets" | "corsOrigins">;

export type ProjectJwtClaims = typeof jwtClaimsSchema.infer;

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
 * Full HMAC-SHA256 JWT verification using Hono's built-in JWT helper.
 * Validates shape: { sub: string, scope: "write"|"read"|"manage", exp: number, stream_id?: string }
 */
export async function verifyProjectJwt(
  token: string,
  signingSecret: string,
): Promise<ProjectJwtClaims | null> {
  try {
    const payload = await verify(token, signingSecret, "HS256");

    const claims = jwtClaimsSchema(payload);
    if (claims instanceof type.errors) return null;
    return claims;
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
// Hono Middleware
// ============================================================================

// biome-ignore lint: Hono context typing is complex; middleware is wired through the app
export async function authenticationMiddleware(c: any, next: () => Promise<void>): Promise<void> {
  const token = extractBearerToken(c.req.raw);
  if (!token) {
    c.set("jwtClaims", null);
    return next();
  }

  const projectConfig = c.get("projectConfig");
  if (!projectConfig) {
    c.set("jwtClaims", null);
    return next();
  }

  // Validate JWT signature against project's signing secrets
  const claims = await verifyProjectJwtMultiKey(token, projectConfig);
  if (!claims) {
    c.set("jwtClaims", null);
    return next();
  }

  // Check token is not expired
  if (Date.now() >= claims.exp * 1000) {
    c.set("jwtClaims", null);
    return next();
  }

  c.set("jwtClaims", claims);
  return next();
}
