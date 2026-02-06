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
    if (deleteMatch && !pathname.includes("/subscribe") && !pathname.includes("/unsubscribe")) {
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
        // Malformed body — let Zod validation handle it downstream
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
        // Malformed body — let Zod validation handle it downstream
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

export function bearerTokenAuth(): AuthorizeSubscription<{ AUTH_TOKEN?: string }> {
  return (request, _route, env) => {
    if (!env.AUTH_TOKEN) return { ok: true };
    const token = extractBearerToken(request);
    if (token !== env.AUTH_TOKEN) {
      return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
    }
    return { ok: true };
  };
}

/**
 * Project key auth for subscriptions.
 * Priority chain:
 * 1. No auth configured → allow all
 * 2. Bearer matches AUTH_TOKEN → allow (superuser)
 * 3. Bearer found in PROJECT_KEYS KV → allow if project matches URL param, else 403
 * 4. Otherwise → 401
 */
export function projectKeyAuth(): AuthorizeSubscription<{ AUTH_TOKEN?: string; PROJECT_KEYS?: KVNamespace }> {
  return async (request, route, env) => {
    if (!env.AUTH_TOKEN && !env.PROJECT_KEYS) return { ok: true };

    const token = extractBearerToken(request);
    if (!token) {
      return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
    }

    // Superuser: AUTH_TOKEN bypasses project check
    if (env.AUTH_TOKEN && token === env.AUTH_TOKEN) {
      return { ok: true };
    }

    // Project key lookup
    if (!env.PROJECT_KEYS) {
      return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
    }

    const value = await env.PROJECT_KEYS.get(token, "json") as { project: string } | null;
    if (!value) {
      return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
    }

    // Check project matches URL
    if (value.project !== route.project) {
      return { ok: false, response: Response.json({ error: "Forbidden" }, { status: 403 }) };
    }

    return { ok: true };
  };
}
