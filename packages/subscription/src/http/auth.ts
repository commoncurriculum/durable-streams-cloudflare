export type SubscriptionAuthResult = { ok: true } | { ok: false; response: Response };

export type SubscriptionRoute =
  | { action: "publish"; project: string; streamId: string }
  | { action: "subscribe"; project: string; streamId: string; sessionId: string }
  | { action: "unsubscribe"; project: string; streamId: string; sessionId: string }
  | { action: "getSession"; project: string; sessionId: string }
  | { action: "touchSession"; project: string; sessionId: string }
  | { action: "deleteSession"; project: string; sessionId: string };

export type AuthorizeSubscription<E = unknown> = (
  request: Request,
  route: SubscriptionRoute,
  env: E,
) => SubscriptionAuthResult | Promise<SubscriptionAuthResult>;

export type ProjectConfig = { signingSecrets: string[]; corsOrigins?: string[] };

export type ProjectJwtEnv = {
  /**
   * KV namespace storing per-project signing secrets.
   * SECURITY: Must use private ACL — contains JWT signing secrets.
   */
  REGISTRY: KVNamespace;
};

// Path-based route patterns with project segment
const PUBLISH_RE = /^\/v1\/([^/]+)\/publish\/(.+)$/;
const SESSION_GET_RE = /^\/v1\/([^/]+)\/session\/([^/]+)$/;
const SESSION_TOUCH_RE = /^\/v1\/([^/]+)\/session\/([^/]+)\/touch$/;
const SESSION_DELETE_RE = /^\/v1\/([^/]+)\/session\/([^/]+)$/;
const SUBSCRIBE_RE = /^\/v1\/([^/]+)\/subscribe$/;
const UNSUBSCRIBE_RE = /^\/v1\/([^/]+)\/unsubscribe$/;

/**
 * Parse the incoming request into a SubscriptionRoute for auth decisions.
 * Returns null for unknown paths or malformed bodies (lets Hono handle 404/400).
 */
export async function parseRoute(
  method: string,
  pathname: string,
  request: Request,
): Promise<SubscriptionRoute | null> {
  // Publish: POST /v1/:project/publish/:streamId
  if (method === "POST") {
    const publishMatch = PUBLISH_RE.exec(pathname);
    if (publishMatch) {
      return { action: "publish", project: publishMatch[1], streamId: publishMatch[2] };
    }
  }

  // Session touch: POST /v1/:project/session/:sessionId/touch
  if (method === "POST") {
    const touchMatch = SESSION_TOUCH_RE.exec(pathname);
    if (touchMatch) {
      return { action: "touchSession", project: touchMatch[1], sessionId: touchMatch[2] };
    }
  }

  // Session get: GET /v1/:project/session/:sessionId
  if (method === "GET") {
    const getMatch = SESSION_GET_RE.exec(pathname);
    if (getMatch) {
      return { action: "getSession", project: getMatch[1], sessionId: getMatch[2] };
    }
  }

  // Session delete: DELETE /v1/:project/session/:sessionId
  if (method === "DELETE" && SESSION_DELETE_RE.test(pathname)) {
    const deleteMatch = SESSION_DELETE_RE.exec(pathname);
    if (deleteMatch) {
      return { action: "deleteSession", project: deleteMatch[1], sessionId: deleteMatch[2] };
    }
  }

  // Body-based routes: subscribe and unsubscribe
  // Uses request.clone() so the body is still available for Hono
  if (method === "POST") {
    const subscribeMatch = SUBSCRIBE_RE.exec(pathname);
    if (subscribeMatch) {
      try {
        const body = await request.clone().json() as Record<string, unknown>;
        if (typeof body.streamId === "string" && typeof body.sessionId === "string") {
          return { action: "subscribe", project: subscribeMatch[1], streamId: body.streamId, sessionId: body.sessionId };
        }
      } catch {
        // Malformed body — let ArkType validation handle it downstream
      }
      return null;
    }
  }

  if (method === "DELETE") {
    const unsubscribeMatch = UNSUBSCRIBE_RE.exec(pathname);
    if (unsubscribeMatch) {
      try {
        const body = await request.clone().json() as Record<string, unknown>;
        if (typeof body.streamId === "string" && typeof body.sessionId === "string") {
          return { action: "unsubscribe", project: unsubscribeMatch[1], streamId: body.streamId, sessionId: body.sessionId };
        }
      } catch {
        // Malformed body — let ArkType validation handle it downstream
      }
      return null;
    }
  }

  return null;
}

export function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/.exec(auth);
  return match ? match[1] : null;
}

// ============================================================================
// JWT Helpers (shared with core)
// ============================================================================

import { jwtVerify } from "jose";

type ProjectJwtClaims = {
  sub: string;
  scope: "write" | "read";
  exp: number;
  stream_id?: string;
};

function extractCorsOrigins(record: Record<string, unknown>): { corsOrigins?: string[] } {
  if (!Array.isArray(record.corsOrigins)) return {};
  const origins = record.corsOrigins.filter((o): o is string => typeof o === "string" && o.length > 0);
  return origins.length > 0 ? { corsOrigins: origins } : {};
}

/**
 * Look up project config from REGISTRY KV.
 * Uses the same read logic as core's registry module.
 */
export async function lookupProjectConfig(
  kv: KVNamespace,
  projectId: string,
): Promise<ProjectConfig | null> {
  const raw = await kv.get(projectId, "json");
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  
  // Normalize legacy single-secret format to array format
  if (!Array.isArray(record.signingSecrets) && typeof record.signingSecret === "string") {
    record.signingSecrets = [record.signingSecret];
    delete record.signingSecret;
  }
  
  // Validate we have signing secrets
  if (!Array.isArray(record.signingSecrets) || record.signingSecrets.length === 0) {
    return null;
  }
  
  return {
    signingSecrets: record.signingSecrets.filter((s): s is string => typeof s === "string" && s.length > 0),
    ...extractCorsOrigins(record),
  };
}

async function verifyProjectJwt(
  token: string,
  signingSecret: string,
): Promise<ProjectJwtClaims | null> {
  try {
    const secret = new TextEncoder().encode(signingSecret);
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });

    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    if (payload.scope !== "write" && payload.scope !== "read") return null;
    if (typeof payload.exp !== "number") return null;

    return {
      sub: payload.sub,
      scope: payload.scope as "write" | "read",
      exp: payload.exp,
      stream_id: typeof payload.stream_id === "string" ? payload.stream_id : undefined,
    };
  } catch {
    return null;
  }
}

async function verifyProjectJwtMultiKey(
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
// Per-Project JWT Auth for Subscriptions
// ============================================================================

/** Actions that require write scope */
const WRITE_ACTIONS = new Set(["publish", "unsubscribe", "deleteSession"]);

/**
 * Per-project JWT auth for subscription routes.
 *
 * Scope mapping:
 * - publish → requires "write"
 * - subscribe, getSession, touchSession → "read" or "write"
 * - unsubscribe, deleteSession → requires "write"
 */
export function projectJwtAuth(): AuthorizeSubscription<ProjectJwtEnv> {
  return async (request, route, env) => {
    if (!env.REGISTRY) {
      return { ok: false, response: Response.json({ error: "REGISTRY not configured" }, { status: 500 }) };
    }

    const token = extractBearerToken(request);
    if (!token) {
      return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
    }

    const config = await lookupProjectConfig(env.REGISTRY, route.project);
    if (!config) {
      return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
    }

    const claims = await verifyProjectJwtMultiKey(token, config);
    if (!claims) {
      return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
    }

    if (claims.sub !== route.project) {
      return { ok: false, response: Response.json({ error: "Forbidden" }, { status: 403 }) };
    }

    if (Date.now() >= claims.exp * 1000) {
      return { ok: false, response: Response.json({ error: "Token expired" }, { status: 401 }) };
    }

    if (WRITE_ACTIONS.has(route.action) && claims.scope !== "write") {
      return { ok: false, response: Response.json({ error: "Forbidden" }, { status: 403 }) };
    }

    if (claims.stream_id && "streamId" in route && claims.stream_id !== route.streamId) {
      return { ok: false, response: Response.json({ error: "Forbidden" }, { status: 403 }) };
    }

    return { ok: true };
  };
}
