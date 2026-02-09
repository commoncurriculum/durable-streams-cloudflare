import { describe, it, expect, vi } from "vitest";
import { parseRoute, extractBearerToken, projectJwtAuth } from "../src/http/auth";
import type { SubscriptionRoute } from "../src/http/auth";

// ============================================================================
// JWT Test Helpers
// ============================================================================

function base64UrlEncode(data: Uint8Array): string {
  const binary = String.fromCharCode(...data);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createTestJwt(
  claims: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): Promise<string> {
  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  const signatureB64 = base64UrlEncode(new Uint8Array(signature));

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

function createMockKV(data: Record<string, unknown>): KVNamespace {
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const value = data[key];
      if (value === undefined) return null;
      if (type === "json") return value;
      return JSON.stringify(value);
    }),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

const SECRET = "test-signing-secret-for-hmac-256";
const PROJECT = "myapp";

function validClaims(overrides?: Record<string, unknown>) {
  return {
    sub: PROJECT,
    scope: "write",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function makeRequest(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("http://localhost/v1/myapp/publish/my-stream", { headers });
}

// ============================================================================
// Tests
// ============================================================================

describe("parseRoute", () => {
  function req(method: string, url: string, body?: object): Request {
    const init: RequestInit = { method };
    if (body) {
      init.body = JSON.stringify(body);
      init.headers = { "Content-Type": "application/json" };
    }
    return new Request(`http://localhost${url}`, init);
  }

  it("parses POST /v1/:project/publish/:streamId", async () => {
    const route = await parseRoute("POST", "/v1/myapp/publish/my-stream", req("POST", "/v1/myapp/publish/my-stream"));
    expect(route).toEqual({ action: "publish", project: "myapp", streamId: "my-stream" });
  });

  it("parses publish with complex streamId", async () => {
    const route = await parseRoute("POST", "/v1/myapp/publish/org:doc-123", req("POST", "/v1/myapp/publish/org:doc-123"));
    expect(route).toEqual({ action: "publish", project: "myapp", streamId: "org:doc-123" });
  });

  it("parses GET /v1/:project/session/:sessionId", async () => {
    const route = await parseRoute("GET", "/v1/myapp/session/sess-1", req("GET", "/v1/myapp/session/sess-1"));
    expect(route).toEqual({ action: "getSession", project: "myapp", sessionId: "sess-1" });
  });

  it("parses POST /v1/:project/session/:sessionId/touch", async () => {
    const route = await parseRoute("POST", "/v1/myapp/session/sess-1/touch", req("POST", "/v1/myapp/session/sess-1/touch"));
    expect(route).toEqual({ action: "touchSession", project: "myapp", sessionId: "sess-1" });
  });

  it("parses DELETE /v1/:project/session/:sessionId", async () => {
    const route = await parseRoute("DELETE", "/v1/myapp/session/sess-1", req("DELETE", "/v1/myapp/session/sess-1"));
    expect(route).toEqual({ action: "deleteSession", project: "myapp", sessionId: "sess-1" });
  });

  it("parses POST /v1/:project/subscribe with body", async () => {
    const body = { sessionId: "sess-1", streamId: "stream-a" };
    const route = await parseRoute("POST", "/v1/myapp/subscribe", req("POST", "/v1/myapp/subscribe", body));
    expect(route).toEqual({ action: "subscribe", project: "myapp", streamId: "stream-a", sessionId: "sess-1" });
  });

  it("parses DELETE /v1/:project/unsubscribe with body", async () => {
    const body = { sessionId: "sess-1", streamId: "stream-a" };
    const route = await parseRoute("DELETE", "/v1/myapp/unsubscribe", req("DELETE", "/v1/myapp/unsubscribe", body));
    expect(route).toEqual({ action: "unsubscribe", project: "myapp", streamId: "stream-a", sessionId: "sess-1" });
  });

  it("returns null for subscribe with malformed body", async () => {
    const route = await parseRoute("POST", "/v1/myapp/subscribe", req("POST", "/v1/myapp/subscribe"));
    expect(route).toBeNull();
  });

  it("returns null for subscribe with missing fields", async () => {
    const body = { sessionId: "sess-1" }; // missing streamId
    const route = await parseRoute("POST", "/v1/myapp/subscribe", req("POST", "/v1/myapp/subscribe", body));
    expect(route).toBeNull();
  });

  it("parses DELETE session even when sessionId contains 'subscribe'", async () => {
    const route = await parseRoute("DELETE", "/v1/myapp/session/subscribe", req("DELETE", "/v1/myapp/session/subscribe"));
    expect(route).toEqual({ action: "deleteSession", project: "myapp", sessionId: "subscribe" });
  });

  it("parses DELETE session even when sessionId contains 'unsubscribe'", async () => {
    const route = await parseRoute("DELETE", "/v1/myapp/session/unsubscribe", req("DELETE", "/v1/myapp/session/unsubscribe"));
    expect(route).toEqual({ action: "deleteSession", project: "myapp", sessionId: "unsubscribe" });
  });

  it("returns null for unknown paths", async () => {
    const route = await parseRoute("GET", "/health", req("GET", "/health"));
    expect(route).toBeNull();
  });

  it("returns null for wrong method on known path", async () => {
    const route = await parseRoute("GET", "/v1/myapp/publish/my-stream", req("GET", "/v1/myapp/publish/my-stream"));
    expect(route).toBeNull();
  });

  it("returns null for old (non-project) paths", async () => {
    const route = await parseRoute("POST", "/v1/publish/my-stream", req("POST", "/v1/publish/my-stream"));
    expect(route).toBeNull();
  });
});

describe("extractBearerToken", () => {
  it("extracts token from valid header", () => {
    const request = new Request("http://localhost", {
      headers: { Authorization: "Bearer my-token" },
    });
    expect(extractBearerToken(request)).toBe("my-token");
  });

  it("returns null when no Authorization header", () => {
    const request = new Request("http://localhost");
    expect(extractBearerToken(request)).toBeNull();
  });

  it("returns null for non-Bearer scheme", () => {
    const request = new Request("http://localhost", {
      headers: { Authorization: "Basic abc123" },
    });
    expect(extractBearerToken(request)).toBeNull();
  });
});

describe("projectJwtAuth", () => {
  const auth = projectJwtAuth();
  const publishRoute: SubscriptionRoute = { action: "publish", project: PROJECT, streamId: "s" };
  const subscribeRoute: SubscriptionRoute = { action: "subscribe", project: PROJECT, streamId: "s", sessionId: "sess-1" };
  const getSessionRoute: SubscriptionRoute = { action: "getSession", project: PROJECT, sessionId: "sess-1" };
  const touchRoute: SubscriptionRoute = { action: "touchSession", project: PROJECT, sessionId: "sess-1" };
  const unsubscribeRoute: SubscriptionRoute = { action: "unsubscribe", project: PROJECT, streamId: "s", sessionId: "sess-1" };
  const deleteRoute: SubscriptionRoute = { action: "deleteSession", project: PROJECT, sessionId: "sess-1" };

  it("rejects with 500 when REGISTRY not configured", async () => {
    const result = await auth(makeRequest("token"), publishRoute, {} as any);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(500);
  });

  it("rejects with 401 when no token provided", async () => {
    const kv = createMockKV({ [PROJECT]: { signingSecret: SECRET } });
    const result = await auth(makeRequest(), publishRoute, { REGISTRY: kv });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("rejects with 401 when project not found in KV", async () => {
    const kv = createMockKV({});
    const token = await createTestJwt(validClaims(), SECRET);
    const result = await auth(makeRequest(token), publishRoute, { REGISTRY: kv });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("rejects with 401 when JWT signature is invalid", async () => {
    const kv = createMockKV({ [PROJECT]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims(), "wrong-secret");
    const result = await auth(makeRequest(token), publishRoute, { REGISTRY: kv });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("rejects with 403 when sub does not match project", async () => {
    const kv = createMockKV({ [PROJECT]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ sub: "other-project" }), SECRET);
    const result = await auth(makeRequest(token), publishRoute, { REGISTRY: kv });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("rejects with 401 when token is expired", async () => {
    const kv = createMockKV({ [PROJECT]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ exp: Math.floor(Date.now() / 1000) - 60 }), SECRET);
    const result = await auth(makeRequest(token), publishRoute, { REGISTRY: kv });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  // Write-scope actions
  it("allows valid write JWT for publish", async () => {
    const kv = createMockKV({ [PROJECT]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims(), SECRET);
    const result = await auth(makeRequest(token), publishRoute, { REGISTRY: kv });
    expect(result).toEqual({ ok: true });
  });

  it("rejects read JWT for publish (requires write)", async () => {
    const kv = createMockKV({ [PROJECT]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ scope: "read" }), SECRET);
    const result = await auth(makeRequest(token), publishRoute, { REGISTRY: kv });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("rejects read JWT for unsubscribe (requires write)", async () => {
    const kv = createMockKV({ [PROJECT]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ scope: "read" }), SECRET);
    const result = await auth(makeRequest(token), unsubscribeRoute, { REGISTRY: kv });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("rejects read JWT for deleteSession (requires write)", async () => {
    const kv = createMockKV({ [PROJECT]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ scope: "read" }), SECRET);
    const result = await auth(makeRequest(token), deleteRoute, { REGISTRY: kv });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  // Read-scope actions
  it("allows read JWT for subscribe", async () => {
    const kv = createMockKV({ [PROJECT]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ scope: "read" }), SECRET);
    const result = await auth(makeRequest(token), subscribeRoute, { REGISTRY: kv });
    expect(result).toEqual({ ok: true });
  });

  it("allows read JWT for getSession", async () => {
    const kv = createMockKV({ [PROJECT]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ scope: "read" }), SECRET);
    const result = await auth(makeRequest(token), getSessionRoute, { REGISTRY: kv });
    expect(result).toEqual({ ok: true });
  });

  it("allows read JWT for touchSession", async () => {
    const kv = createMockKV({ [PROJECT]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ scope: "read" }), SECRET);
    const result = await auth(makeRequest(token), touchRoute, { REGISTRY: kv });
    expect(result).toEqual({ ok: true });
  });

  it("allows write JWT for read-scope actions", async () => {
    const kv = createMockKV({ [PROJECT]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ scope: "write" }), SECRET);
    const result = await auth(makeRequest(token), subscribeRoute, { REGISTRY: kv });
    expect(result).toEqual({ ok: true });
  });

  // stream_id claim
  it("allows JWT with matching stream_id on publish", async () => {
    const kv = createMockKV({ [PROJECT]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ stream_id: "s" }), SECRET);
    const result = await auth(makeRequest(token), publishRoute, { REGISTRY: kv });
    expect(result).toEqual({ ok: true });
  });

  it("rejects JWT with mismatched stream_id on publish", async () => {
    const kv = createMockKV({ [PROJECT]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ stream_id: "other-stream" }), SECRET);
    const result = await auth(makeRequest(token), publishRoute, { REGISTRY: kv });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("rejects JWT with mismatched stream_id on subscribe", async () => {
    const kv = createMockKV({ [PROJECT]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ scope: "read", stream_id: "other-stream" }), SECRET);
    const result = await auth(makeRequest(token), subscribeRoute, { REGISTRY: kv });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("allows JWT without stream_id on any route", async () => {
    const kv = createMockKV({ [PROJECT]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims(), SECRET);
    const result = await auth(makeRequest(token), publishRoute, { REGISTRY: kv });
    expect(result).toEqual({ ok: true });
  });

  it("ignores stream_id on session routes (no streamId in route)", async () => {
    const kv = createMockKV({ [PROJECT]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ scope: "read", stream_id: "any-stream" }), SECRET);
    const result = await auth(makeRequest(token), getSessionRoute, { REGISTRY: kv });
    expect(result).toEqual({ ok: true });
  });
});
