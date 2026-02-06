export type SubscriptionAuthResult = { ok: true } | { ok: false; response: Response };

export type SubscriptionRoute =
  | { action: "publish"; streamId: string }
  | { action: "subscribe"; streamId: string; sessionId: string }
  | { action: "unsubscribe"; streamId: string; sessionId: string }
  | { action: "getSession"; sessionId: string }
  | { action: "touchSession"; sessionId: string }
  | { action: "deleteSession"; sessionId: string };

export type AuthorizeSubscription<E = unknown> = (
  request: Request,
  route: SubscriptionRoute,
  env: E,
) => SubscriptionAuthResult | Promise<SubscriptionAuthResult>;

// Path-based route patterns
const PUBLISH_RE = /^\/v1\/publish\/(.+)$/;
const SESSION_GET_RE = /^\/v1\/session\/([^/]+)$/;
const SESSION_TOUCH_RE = /^\/v1\/session\/([^/]+)\/touch$/;
const SESSION_DELETE_RE = /^\/v1\/session\/([^/]+)$/;

/**
 * Parse the incoming request into a SubscriptionRoute for auth decisions.
 * Returns null for unknown paths or malformed bodies (lets Hono handle 404/400).
 */
export async function parseRoute(
  method: string,
  pathname: string,
  request: Request,
): Promise<SubscriptionRoute | null> {
  // Publish: POST /v1/publish/:streamId
  if (method === "POST") {
    const publishMatch = PUBLISH_RE.exec(pathname);
    if (publishMatch) {
      return { action: "publish", streamId: publishMatch[1] };
    }
  }

  // Session touch: POST /v1/session/:sessionId/touch
  if (method === "POST") {
    const touchMatch = SESSION_TOUCH_RE.exec(pathname);
    if (touchMatch) {
      return { action: "touchSession", sessionId: touchMatch[1] };
    }
  }

  // Session get: GET /v1/session/:sessionId
  if (method === "GET") {
    const getMatch = SESSION_GET_RE.exec(pathname);
    if (getMatch) {
      return { action: "getSession", sessionId: getMatch[1] };
    }
  }

  // Session delete: DELETE /v1/session/:sessionId
  if (method === "DELETE" && SESSION_DELETE_RE.test(pathname)) {
    const deleteMatch = SESSION_DELETE_RE.exec(pathname);
    if (deleteMatch && !pathname.includes("/subscribe") && !pathname.includes("/unsubscribe")) {
      return { action: "deleteSession", sessionId: deleteMatch[1] };
    }
  }

  // Body-based routes: subscribe and unsubscribe
  // Uses request.clone() so the body is still available for Hono
  if (method === "POST" && pathname === "/v1/subscribe") {
    try {
      const body = await request.clone().json() as Record<string, unknown>;
      if (typeof body.streamId === "string" && typeof body.sessionId === "string") {
        return { action: "subscribe", streamId: body.streamId, sessionId: body.sessionId };
      }
    } catch {
      // Malformed body — let Zod validation handle it downstream
    }
    return null;
  }

  if (method === "DELETE" && pathname === "/v1/unsubscribe") {
    try {
      const body = await request.clone().json() as Record<string, unknown>;
      if (typeof body.streamId === "string" && typeof body.sessionId === "string") {
        return { action: "unsubscribe", streamId: body.streamId, sessionId: body.sessionId };
      }
    } catch {
      // Malformed body — let Zod validation handle it downstream
    }
    return null;
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
