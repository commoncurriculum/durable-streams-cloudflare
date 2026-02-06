import { describe, it, expect, vi } from "vitest";
import { parseRoute, extractBearerToken, bearerTokenAuth, projectKeyAuth } from "../src/http/auth";
import type { SubscriptionRoute } from "../src/http/auth";

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

describe("bearerTokenAuth", () => {
  const auth = bearerTokenAuth();
  const dummyRoute: SubscriptionRoute = { action: "publish", project: "myapp", streamId: "s" };

  it("allows all requests when AUTH_TOKEN is not set", () => {
    const request = new Request("http://localhost");
    const result = auth(request, dummyRoute, {});
    expect(result).toEqual({ ok: true });
  });

  it("allows requests with correct token", () => {
    const request = new Request("http://localhost", {
      headers: { Authorization: "Bearer secret" },
    });
    const result = auth(request, dummyRoute, { AUTH_TOKEN: "secret" });
    expect(result).toEqual({ ok: true });
  });

  it("rejects requests with wrong token", () => {
    const request = new Request("http://localhost", {
      headers: { Authorization: "Bearer wrong" },
    });
    const result = auth(request, dummyRoute, { AUTH_TOKEN: "secret" });
    expect(result).toHaveProperty("ok", false);
  });

  it("rejects requests with no token when AUTH_TOKEN is set", () => {
    const request = new Request("http://localhost");
    const result = auth(request, dummyRoute, { AUTH_TOKEN: "secret" });
    expect(result).toHaveProperty("ok", false);
  });

  it("returns 401 JSON response on rejection", async () => {
    const request = new Request("http://localhost");
    const result = await auth(request, dummyRoute, { AUTH_TOKEN: "secret" });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body).toEqual({ error: "Unauthorized" });
    }
  });
});

describe("projectKeyAuth", () => {
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

  const auth = projectKeyAuth();
  const route: SubscriptionRoute = { action: "publish", project: "myapp", streamId: "s" };

  function makeRequest(token?: string): Request {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return new Request("http://localhost/v1/myapp/publish/s", { headers });
  }

  it("allows all when no auth configured", async () => {
    const result = await auth(makeRequest(), route, {});
    expect(result).toEqual({ ok: true });
  });

  it("rejects with 401 when no token but auth configured", async () => {
    const result = await auth(makeRequest(), route, { AUTH_TOKEN: "super" });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("allows superuser AUTH_TOKEN regardless of project", async () => {
    const otherRoute: SubscriptionRoute = { action: "publish", project: "other", streamId: "s" };
    const result = await auth(makeRequest("super"), otherRoute, { AUTH_TOKEN: "super" });
    expect(result).toEqual({ ok: true });
  });

  it("allows valid project key with matching project", async () => {
    const kv = createMockKV({ "sk_test_123": { project: "myapp" } });
    const result = await auth(makeRequest("sk_test_123"), route, { PROJECT_KEYS: kv });
    expect(result).toEqual({ ok: true });
  });

  it("rejects valid project key with wrong project (403)", async () => {
    const kv = createMockKV({ "sk_test_123": { project: "other" } });
    const result = await auth(makeRequest("sk_test_123"), route, { PROJECT_KEYS: kv });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("rejects unknown key with 401", async () => {
    const kv = createMockKV({});
    const result = await auth(makeRequest("unknown-key"), route, { PROJECT_KEYS: kv });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("AUTH_TOKEN takes precedence over KV lookup", async () => {
    const kv = createMockKV({});
    const result = await auth(makeRequest("super"), route, { AUTH_TOKEN: "super", PROJECT_KEYS: kv });
    expect(result).toEqual({ ok: true });
    expect(kv.get).not.toHaveBeenCalled();
  });
});
