import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AdminSubscriptionEnv } from "../src/types";
import { handleSessionInspect, handleStreamInspect } from "../src/routes/inspect";
import { handleTest } from "../src/routes/test";

function createTestApp() {
  const app = new Hono<{ Bindings: AdminSubscriptionEnv }>();
  app.get("/api/session/:id", handleSessionInspect);
  app.get("/api/stream/:id", handleStreamInspect);
  app.post("/api/test", handleTest);
  return app;
}

function makeFetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return {
    fetch: handler,
    connect: () => {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function makeEnv(overrides: Partial<AdminSubscriptionEnv> = {}): AdminSubscriptionEnv {
  return {
    SUBSCRIPTION: {} as Fetcher,
    CF_ACCOUNT_ID: "test-account-id",
    CF_API_TOKEN: "test-api-token",
    ADMIN_TOKEN: "secret",
    ...overrides,
  };
}

describe("session inspect route", () => {
  it("proxies to subscription worker with correct URL and auth header", async () => {
    let capturedRequest: Request | null = null;

    const sub = makeFetcher(async (req) => {
      capturedRequest = req;
      return new Response(JSON.stringify({ sessionId: "test-session", subscriptions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const app = createTestApp();
    const response = await app.request("/api/session/test-session", {}, makeEnv({ SUBSCRIPTION: sub }));

    expect(response.status).toBe(200);
    expect(capturedRequest).not.toBeNull();

    const url = new URL(capturedRequest!.url);
    expect(url.pathname).toBe("/v1/session/test-session");
    expect(capturedRequest!.headers.get("Authorization")).toBe("Bearer secret");

    const data = await response.json();
    expect(data.sessionId).toBe("test-session");
  });

  it("URL-encodes session IDs with special characters", async () => {
    let capturedUrl = "";

    const sub = makeFetcher(async (req) => {
      capturedUrl = req.url;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const app = createTestApp();
    await app.request("/api/session/my%3Asession", {}, makeEnv({ SUBSCRIPTION: sub }));

    expect(capturedUrl).toContain("my%3Asession");
  });

  it("forwards error responses from subscription worker", async () => {
    const sub = makeFetcher(async () => {
      return new Response("session not found", { status: 404 });
    });

    const app = createTestApp();
    const response = await app.request("/api/session/missing", {}, makeEnv({ SUBSCRIPTION: sub }));

    expect(response.status).toBe(404);
  });
});

describe("stream inspect route", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns analytics data for a valid stream ID", async () => {
    const mockData = [{ session_id: "sess-1", net: 1 }];

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: mockData }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const app = createTestApp();
    const response = await app.request("/api/stream/my-stream", {}, makeEnv());

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual(mockData);
  });

  it("rejects invalid stream IDs", async () => {
    const app = createTestApp();
    const response = await app.request("/api/stream/bad%20id%3B%20DROP", {}, makeEnv());

    expect(response.status).toBe(500);
  });
});

describe("test route", () => {
  it("sends POST to /v1/subscribe for subscribe action", async () => {
    let capturedRequest: Request | null = null;

    const sub = makeFetcher(async (req) => {
      capturedRequest = req;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const app = createTestApp();
    const response = await app.request("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "subscribe",
        sessionId: "sess-1",
        streamId: "stream-1",
      }),
    }, makeEnv({ SUBSCRIPTION: sub }));

    expect(response.status).toBe(200);
    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.method).toBe("POST");

    const url = new URL(capturedRequest!.url);
    expect(url.pathname).toBe("/v1/subscribe");
    expect(capturedRequest!.headers.get("Authorization")).toBe("Bearer secret");

    const body = await capturedRequest!.json();
    expect(body).toEqual({ sessionId: "sess-1", streamId: "stream-1" });
  });

  it("sends DELETE to /v1/unsubscribe for unsubscribe action", async () => {
    let capturedRequest: Request | null = null;

    const sub = makeFetcher(async (req) => {
      capturedRequest = req;
      return new Response(null, { status: 200 });
    });

    const app = createTestApp();
    await app.request("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "unsubscribe",
        sessionId: "sess-1",
        streamId: "stream-1",
      }),
    }, makeEnv({ SUBSCRIPTION: sub }));

    expect(capturedRequest!.method).toBe("DELETE");
    const url = new URL(capturedRequest!.url);
    expect(url.pathname).toBe("/v1/unsubscribe");
  });

  it("sends POST to /v1/publish/:streamId for publish action", async () => {
    let capturedRequest: Request | null = null;

    const sub = makeFetcher(async (req) => {
      capturedRequest = req;
      return new Response(null, {
        status: 200,
        headers: { "X-Fanout-Count": "3" },
      });
    });

    const app = createTestApp();
    const response = await app.request("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "publish",
        streamId: "stream-1",
        contentType: "text/plain",
        body: "hello world",
      }),
    }, makeEnv({ SUBSCRIPTION: sub }));

    expect(capturedRequest!.method).toBe("POST");
    const url = new URL(capturedRequest!.url);
    expect(url.pathname).toBe("/v1/publish/stream-1");
    expect(capturedRequest!.headers.get("Content-Type")).toBe("text/plain");

    const data = await response.json();
    expect(data.headers["x-fanout-count"]).toBe("3");
  });

  it("sends POST to /v1/session/:id/touch for touch action", async () => {
    let capturedRequest: Request | null = null;

    const sub = makeFetcher(async (req) => {
      capturedRequest = req;
      return new Response(null, { status: 200 });
    });

    const app = createTestApp();
    await app.request("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "touch",
        sessionId: "sess-1",
      }),
    }, makeEnv({ SUBSCRIPTION: sub }));

    expect(capturedRequest!.method).toBe("POST");
    const url = new URL(capturedRequest!.url);
    expect(url.pathname).toBe("/v1/session/sess-1/touch");
  });

  it("sends DELETE to /v1/session/:id for delete action", async () => {
    let capturedRequest: Request | null = null;

    const sub = makeFetcher(async (req) => {
      capturedRequest = req;
      return new Response(null, { status: 200 });
    });

    const app = createTestApp();
    await app.request("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "delete",
        sessionId: "sess-1",
      }),
    }, makeEnv({ SUBSCRIPTION: sub }));

    expect(capturedRequest!.method).toBe("DELETE");
    const url = new URL(capturedRequest!.url);
    expect(url.pathname).toBe("/v1/session/sess-1");
  });

  it("validates invalid action", async () => {
    const app = createTestApp();
    const response = await app.request("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "invalid", streamId: "test" }),
    }, makeEnv());

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("action");
  });

  it("validates subscribe requires sessionId and streamId", async () => {
    const app = createTestApp();
    const response = await app.request("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "subscribe", sessionId: "sess-1" }),
    }, makeEnv());

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("streamId");
  });

  it("validates publish requires streamId", async () => {
    const app = createTestApp();
    const response = await app.request("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "publish", body: "data" }),
    }, makeEnv());

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("streamId");
  });

  it("defaults publish content type to application/json", async () => {
    let capturedContentType = "";

    const sub = makeFetcher(async (req) => {
      capturedContentType = req.headers.get("Content-Type") ?? "";
      return new Response(null, { status: 200 });
    });

    const app = createTestApp();
    await app.request("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "publish",
        streamId: "test",
        body: '{"key":"value"}',
      }),
    }, makeEnv({ SUBSCRIPTION: sub }));

    expect(capturedContentType).toBe("application/json");
  });

  it("returns response status and headers from subscription worker", async () => {
    const sub = makeFetcher(async () => {
      return new Response(null, {
        status: 201,
        statusText: "Created",
        headers: { "X-Fanout-Count": "5", "X-Stream-Next-Offset": "0_0000000000000001" },
      });
    });

    const app = createTestApp();
    const response = await app.request("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "subscribe",
        sessionId: "sess-1",
        streamId: "stream-1",
      }),
    }, makeEnv({ SUBSCRIPTION: sub }));

    const data = await response.json();
    expect(data.status).toBe(201);
    expect(data.statusText).toBe("Created");
    expect(data.headers["x-fanout-count"]).toBe("5");
  });
});
