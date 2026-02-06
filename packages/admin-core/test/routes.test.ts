import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AdminEnv } from "../src/types";
import { handleStreamInspect } from "../src/routes/inspect";
import { handleTest } from "../src/routes/test";

function createTestApp() {
  const app = new Hono<{ Bindings: AdminEnv }>();
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

describe("inspect route", () => {
  it("proxies to core worker with correct URL and auth header", async () => {
    let capturedRequest: Request | null = null;

    const core = makeFetcher(async (req) => {
      capturedRequest = req;
      return new Response(JSON.stringify({ meta: { stream_id: "test" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const app = createTestApp();
    const response = await app.request("/api/stream/my-stream", {}, {
      CORE: core,
      ADMIN_TOKEN: "secret",
    } as AdminEnv);

    expect(response.status).toBe(200);
    expect(capturedRequest).not.toBeNull();

    const url = new URL(capturedRequest!.url);
    expect(url.pathname).toBe("/v1/stream/my-stream/admin");
    expect(capturedRequest!.headers.get("Authorization")).toBe("Bearer secret");

    const data = await response.json();
    expect(data.meta.stream_id).toBe("test");
  });

  it("URL-encodes stream IDs with special characters", async () => {
    let capturedUrl = "";

    const core = makeFetcher(async (req) => {
      capturedUrl = req.url;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const app = createTestApp();
    await app.request("/api/stream/my%2Fstream", {}, {
      CORE: core,
      ADMIN_TOKEN: "secret",
    } as AdminEnv);

    expect(capturedUrl).toContain("my%2Fstream");
  });

  it("forwards error responses from core", async () => {
    const core = makeFetcher(async () => {
      return new Response("stream not found", { status: 404 });
    });

    const app = createTestApp();
    const response = await app.request("/api/stream/missing", {}, {
      CORE: core,
      ADMIN_TOKEN: "secret",
    } as AdminEnv);

    expect(response.status).toBe(404);
  });
});

describe("test route", () => {
  it("sends PUT to core for create action", async () => {
    let capturedRequest: Request | null = null;

    const core = makeFetcher(async (req) => {
      capturedRequest = req;
      return new Response(null, {
        status: 201,
        headers: { "Stream-Next-Offset": "0_0000000000000000" },
      });
    });

    const app = createTestApp();
    const response = await app.request("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamId: "test-stream",
        contentType: "text/plain",
        body: "hello",
        action: "create",
      }),
    }, {
      CORE: core,
      ADMIN_TOKEN: "secret",
    } as AdminEnv);

    expect(response.status).toBe(200);
    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.method).toBe("PUT");

    const url = new URL(capturedRequest!.url);
    expect(url.pathname).toBe("/v1/stream/test-stream");
    expect(capturedRequest!.headers.get("Content-Type")).toBe("text/plain");
    expect(capturedRequest!.headers.get("Authorization")).toBe("Bearer secret");
  });

  it("sends POST to core for append action", async () => {
    let capturedMethod = "";

    const core = makeFetcher(async (req) => {
      capturedMethod = req.method;
      return new Response(null, { status: 200 });
    });

    const app = createTestApp();
    await app.request("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamId: "test-stream",
        body: "more data",
        action: "append",
      }),
    }, {
      CORE: core,
      ADMIN_TOKEN: "secret",
    } as AdminEnv);

    expect(capturedMethod).toBe("POST");
  });

  it("validates missing streamId", async () => {
    const app = createTestApp();
    const response = await app.request("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "data", action: "create" }),
    }, {
      CORE: {} as Fetcher,
      ADMIN_TOKEN: "secret",
    } as AdminEnv);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("streamId");
  });

  it("validates invalid action", async () => {
    const app = createTestApp();
    const response = await app.request("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamId: "test",
        body: "data",
        action: "invalid",
      }),
    }, {
      CORE: {} as Fetcher,
      ADMIN_TOKEN: "secret",
    } as AdminEnv);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("action");
  });

  it("defaults content type to application/json", async () => {
    let capturedContentType = "";

    const core = makeFetcher(async (req) => {
      capturedContentType = req.headers.get("Content-Type") ?? "";
      return new Response(null, { status: 201 });
    });

    const app = createTestApp();
    await app.request("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamId: "test",
        body: '{"key":"value"}',
        action: "create",
      }),
    }, {
      CORE: core,
      ADMIN_TOKEN: "secret",
    } as AdminEnv);

    expect(capturedContentType).toBe("application/json");
  });

  it("returns response headers from core", async () => {
    const core = makeFetcher(async () => {
      return new Response(null, {
        status: 201,
        statusText: "Created",
        headers: {
          "Stream-Next-Offset": "0_0000000000000005",
          "Custom-Header": "value",
        },
      });
    });

    const app = createTestApp();
    const response = await app.request("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamId: "test",
        body: "hello",
        action: "create",
      }),
    }, {
      CORE: core,
      ADMIN_TOKEN: "secret",
    } as AdminEnv);

    const data = await response.json();
    expect(data.status).toBe(201);
    expect(data.statusText).toBe("Created");
    expect(data.headers["stream-next-offset"]).toBe("0_0000000000000005");
  });
});
