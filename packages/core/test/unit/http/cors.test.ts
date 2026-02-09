import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createStreamWorker } from "../../../src/http/create_worker";
import type { BaseEnv } from "../../../src/http/create_worker";

const PROJECT_ID = "_default";

function makeEnv(): BaseEnv {
  return { ...env } as unknown as BaseEnv;
}

function makeCtx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

describe("Per-project CORS from KV", () => {
  let worker: ReturnType<typeof createStreamWorker>;

  beforeEach(async () => {
    worker = createStreamWorker();
    await env.REGISTRY.delete(PROJECT_ID);
    await env.REGISTRY.delete("no-cors-project");
  });

  it("project routes with corsOrigins: ['*'] return wildcard", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({
      signingSecrets: ["test-secret"],
      corsOrigins: ["*"],
    }));

    const response = await worker.fetch!(
      new Request("http://localhost/v1/stream/test-stream", {
        method: "PUT",
        headers: { "Content-Type": "text/plain", Origin: "https://any-origin.com" },
      }) as unknown as Request<unknown, IncomingRequestCfProperties>,
      makeEnv(),
      makeCtx(),
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("Stream-Next-Offset");
  });

  it("project routes with specific corsOrigins return matching origin", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({
      signingSecrets: ["test-secret"],
      corsOrigins: ["https://example.com", "https://test.com"],
    }));

    const response = await worker.fetch!(
      new Request("http://localhost/v1/stream/test-stream", {
        method: "PUT",
        headers: { "Content-Type": "text/plain", Origin: "https://test.com" },
      }) as unknown as Request<unknown, IncomingRequestCfProperties>,
      makeEnv(),
      makeCtx(),
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://test.com");
  });

  it("project routes with no corsOrigins configured have no CORS headers", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({
      signingSecrets: ["test-secret"],
    }));

    const response = await worker.fetch!(
      new Request("http://localhost/v1/stream/test-stream", {
        method: "PUT",
        headers: { "Content-Type": "text/plain", Origin: "https://any-origin.com" },
      }) as unknown as Request<unknown, IncomingRequestCfProperties>,
      makeEnv(),
      makeCtx(),
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("project routes with no KV entry have no CORS headers", async () => {
    const response = await worker.fetch!(
      new Request("http://localhost/v1/stream/test-stream?offset=-1", {
        headers: { Origin: "https://any-origin.com" },
      }) as unknown as Request<unknown, IncomingRequestCfProperties>,
      makeEnv(),
      makeCtx(),
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("OPTIONS preflight at stream paths returns CORS from KV", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({
      signingSecrets: ["test-secret"],
      corsOrigins: ["https://example.com"],
    }));

    const response = await worker.fetch!(
      new Request("http://localhost/v1/stream/test-stream", {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.com",
          "Access-Control-Request-Method": "POST",
        },
      }) as unknown as Request<unknown, IncomingRequestCfProperties>,
      makeEnv(),
      makeCtx(),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("OPTIONS preflight at non-stream paths has no CORS headers", async () => {
    const response = await worker.fetch!(
      new Request("http://localhost/health", {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.com",
          "Access-Control-Request-Method": "GET",
        },
      }) as unknown as Request<unknown, IncomingRequestCfProperties>,
      makeEnv(),
      makeCtx(),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("non-stream routes (/health) have no CORS headers", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({
      signingSecrets: ["test-secret"],
      corsOrigins: ["*"],
    }));

    const response = await worker.fetch!(
      new Request("http://localhost/health", {
        headers: { Origin: "https://any-origin.com" },
      }) as unknown as Request<unknown, IncomingRequestCfProperties>,
      makeEnv(),
      makeCtx(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("CORS headers on error responses (404)", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({
      signingSecrets: ["test-secret"],
      corsOrigins: ["*"],
    }));

    const response = await worker.fetch!(
      new Request("http://localhost/v1/stream/nonexistent?offset=-1") as unknown as Request<unknown, IncomingRequestCfProperties>,
      makeEnv(),
      makeCtx(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("CORS headers on error responses (409 conflict)", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({
      signingSecrets: ["test-secret"],
      corsOrigins: ["*"],
    }));

    // Create a stream with text/plain
    await worker.fetch!(
      new Request("http://localhost/v1/stream/conflict-test", {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
      }) as unknown as Request<unknown, IncomingRequestCfProperties>,
      makeEnv(),
      makeCtx(),
    );

    // Try to re-create with different content type → 409
    const response = await worker.fetch!(
      new Request("http://localhost/v1/stream/conflict-test", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
      }) as unknown as Request<unknown, IncomingRequestCfProperties>,
      makeEnv(),
      makeCtx(),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("uses project-scoped corsOrigins for /v1/:project/stream/:id paths", async () => {
    await env.REGISTRY.put("my-project", JSON.stringify({
      signingSecrets: ["test-secret"],
      corsOrigins: ["https://myapp.com"],
    }));

    const response = await worker.fetch!(
      new Request("http://localhost/v1/my-project/stream/test-stream", {
        method: "PUT",
        headers: { "Content-Type": "text/plain", Origin: "https://myapp.com" },
      }) as unknown as Request<unknown, IncomingRequestCfProperties>,
      makeEnv(),
      makeCtx(),
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://myapp.com");
  });
});
