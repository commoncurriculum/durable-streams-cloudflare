import { describe, it, expect } from "vitest";
import { parseRoute, extractBearerToken, bearerTokenAuth } from "../src/http/auth";
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

  it("parses POST /v1/publish/:streamId", async () => {
    const route = await parseRoute("POST", "/v1/publish/my-stream", req("POST", "/v1/publish/my-stream"));
    expect(route).toEqual({ action: "publish", streamId: "my-stream" });
  });

  it("parses publish with complex streamId", async () => {
    const route = await parseRoute("POST", "/v1/publish/org:doc-123", req("POST", "/v1/publish/org:doc-123"));
    expect(route).toEqual({ action: "publish", streamId: "org:doc-123" });
  });

  it("parses GET /v1/session/:sessionId", async () => {
    const route = await parseRoute("GET", "/v1/session/sess-1", req("GET", "/v1/session/sess-1"));
    expect(route).toEqual({ action: "getSession", sessionId: "sess-1" });
  });

  it("parses POST /v1/session/:sessionId/touch", async () => {
    const route = await parseRoute("POST", "/v1/session/sess-1/touch", req("POST", "/v1/session/sess-1/touch"));
    expect(route).toEqual({ action: "touchSession", sessionId: "sess-1" });
  });

  it("parses DELETE /v1/session/:sessionId", async () => {
    const route = await parseRoute("DELETE", "/v1/session/sess-1", req("DELETE", "/v1/session/sess-1"));
    expect(route).toEqual({ action: "deleteSession", sessionId: "sess-1" });
  });

  it("parses POST /v1/subscribe with body", async () => {
    const body = { sessionId: "sess-1", streamId: "stream-a" };
    const route = await parseRoute("POST", "/v1/subscribe", req("POST", "/v1/subscribe", body));
    expect(route).toEqual({ action: "subscribe", streamId: "stream-a", sessionId: "sess-1" });
  });

  it("parses DELETE /v1/unsubscribe with body", async () => {
    const body = { sessionId: "sess-1", streamId: "stream-a" };
    const route = await parseRoute("DELETE", "/v1/unsubscribe", req("DELETE", "/v1/unsubscribe", body));
    expect(route).toEqual({ action: "unsubscribe", streamId: "stream-a", sessionId: "sess-1" });
  });

  it("returns null for subscribe with malformed body", async () => {
    const route = await parseRoute("POST", "/v1/subscribe", req("POST", "/v1/subscribe"));
    expect(route).toBeNull();
  });

  it("returns null for subscribe with missing fields", async () => {
    const body = { sessionId: "sess-1" }; // missing streamId
    const route = await parseRoute("POST", "/v1/subscribe", req("POST", "/v1/subscribe", body));
    expect(route).toBeNull();
  });

  it("returns null for unknown paths", async () => {
    const route = await parseRoute("GET", "/health", req("GET", "/health"));
    expect(route).toBeNull();
  });

  it("returns null for wrong method on known path", async () => {
    const route = await parseRoute("GET", "/v1/publish/my-stream", req("GET", "/v1/publish/my-stream"));
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
  const dummyRoute: SubscriptionRoute = { action: "publish", streamId: "s" };

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
    const result = auth(request, dummyRoute, { AUTH_TOKEN: "secret" });
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body).toEqual({ error: "Unauthorized" });
    }
  });
});
