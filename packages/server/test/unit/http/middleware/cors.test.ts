import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createStreamWorker } from "../../../../src/http/worker";

const PROJECT_ID = "_default";
const SECRET = "test-secret";

// ============================================================================
// JWT Test Helpers
// ============================================================================

function base64UrlEncode(data: Uint8Array): string {
  const binary = String.fromCharCode(...data);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createTestJwt(claims: Record<string, unknown>, secret: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
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
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function readClaims(overrides?: Record<string, unknown>) {
  return {
    sub: PROJECT_ID,
    scope: "read",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function writeClaims(overrides?: Record<string, unknown>) {
  return {
    sub: PROJECT_ID,
    scope: "write",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

describe("Per-project CORS from KV", () => {
  let worker: ReturnType<typeof createStreamWorker>;

  beforeEach(async () => {
    worker = createStreamWorker();
    await env.REGISTRY.delete(PROJECT_ID);
    await env.REGISTRY.delete("no-cors-project");
  });

  it("project routes with corsOrigins: ['*'] return wildcard", async () => {
    await env.REGISTRY.put(
      PROJECT_ID,
      JSON.stringify({
        signingSecrets: ["test-secret"],
        corsOrigins: ["*"],
      }),
    );

    const response = await worker.app.request(
      "/v1/stream/test-stream",
      {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          Origin: "https://any-origin.com",
        },
      },
      env,
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("Stream-Next-Offset");
  });

  it("project routes with specific corsOrigins return matching origin", async () => {
    await env.REGISTRY.put(
      PROJECT_ID,
      JSON.stringify({
        signingSecrets: ["test-secret"],
        corsOrigins: ["https://example.com", "https://test.com"],
      }),
    );

    const response = await worker.app.request(
      "/v1/stream/test-stream",
      {
        method: "PUT",
        headers: { "Content-Type": "text/plain", Origin: "https://test.com" },
      },
      env,
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://test.com");
  });

  it("project routes with no corsOrigins configured have no CORS headers", async () => {
    await env.REGISTRY.put(
      PROJECT_ID,
      JSON.stringify({
        signingSecrets: ["test-secret"],
      }),
    );

    const response = await worker.app.request(
      "/v1/stream/test-stream",
      {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          Origin: "https://any-origin.com",
        },
      },
      env,
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("project routes with no KV entry have no CORS headers", async () => {
    const response = await worker.app.request(
      "/v1/stream/test-stream?offset=-1",
      {
        headers: { Origin: "https://any-origin.com" },
      },
      env,
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("OPTIONS preflight at stream paths returns CORS from KV", async () => {
    await env.REGISTRY.put(
      PROJECT_ID,
      JSON.stringify({
        signingSecrets: ["test-secret"],
        corsOrigins: ["https://example.com"],
      }),
    );

    const response = await worker.app.request(
      "/v1/stream/test-stream",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.com",
          "Access-Control-Request-Method": "POST",
        },
      },
      env,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("OPTIONS preflight at non-stream paths has no CORS headers", async () => {
    const response = await worker.app.request(
      "/health",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.com",
          "Access-Control-Request-Method": "GET",
        },
      },
      env,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("non-stream routes (/health) have no CORS headers", async () => {
    await env.REGISTRY.put(
      PROJECT_ID,
      JSON.stringify({
        signingSecrets: ["test-secret"],
        corsOrigins: ["*"],
      }),
    );

    const response = await worker.app.request(
      "/health",
      {
        headers: { Origin: "https://any-origin.com" },
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("CORS headers on error responses (404)", async () => {
    await env.REGISTRY.put(
      PROJECT_ID,
      JSON.stringify({
        signingSecrets: [SECRET],
        corsOrigins: ["*"],
      }),
    );

    const token = await createTestJwt(readClaims(), SECRET);
    const response = await worker.app.request(
      "/v1/stream/nonexistent?offset=-1",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      env,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("CORS headers on error responses (409 conflict)", async () => {
    await env.REGISTRY.put(
      PROJECT_ID,
      JSON.stringify({
        signingSecrets: [SECRET],
        corsOrigins: ["*"],
      }),
    );

    const token = await createTestJwt(writeClaims(), SECRET);

    // Create a stream with text/plain
    await worker.app.request(
      "/v1/stream/conflict-test",
      {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          Authorization: `Bearer ${token}`,
        },
      },
      env,
    );

    // Try to re-create with different content type → 409
    const response = await worker.app.request(
      "/v1/stream/conflict-test",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
      env,
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("uses project-scoped corsOrigins for /v1/stream/:project/:id paths", async () => {
    await env.REGISTRY.put(
      "my-project",
      JSON.stringify({
        signingSecrets: ["test-secret"],
        corsOrigins: ["https://myapp.com"],
      }),
    );

    const response = await worker.app.request(
      "/v1/stream/my-project/test-stream",
      {
        method: "PUT",
        headers: { "Content-Type": "text/plain", Origin: "https://myapp.com" },
      },
      env,
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://myapp.com");
  });
});

describe("Global CORS origins (CORS_ORIGINS env var)", () => {
  let worker: ReturnType<typeof createStreamWorker>;

  beforeEach(async () => {
    worker = createStreamWorker();
    await env.REGISTRY.delete("_default");
    await env.REGISTRY.delete("my-project");
  });

  it("CORS_ORIGINS alone enables CORS even without project corsOrigins", async () => {
    await env.REGISTRY.put(
      "_default",
      JSON.stringify({
        signingSecrets: ["test-secret"],
      }),
    );

    const response = await worker.app.request(
      "/v1/stream/test-stream",
      {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          Origin: "https://global.example.com",
        },
      },
      { ...env, CORS_ORIGINS: "https://global.example.com" },
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://global.example.com");
  });

  it("request origin matching a global origin is returned even when project has different origins", async () => {
    await env.REGISTRY.put(
      "my-project",
      JSON.stringify({
        signingSecrets: ["test-secret"],
        corsOrigins: ["https://project.example.com"],
      }),
    );

    const response = await worker.app.request(
      "/v1/stream/my-project/test-stream",
      {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          Origin: "https://global.example.com",
        },
      },
      { ...env, CORS_ORIGINS: "https://global.example.com" },
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://global.example.com");
  });

  it("project origin still works when CORS_ORIGINS is set", async () => {
    await env.REGISTRY.put(
      "my-project",
      JSON.stringify({
        signingSecrets: ["test-secret"],
        corsOrigins: ["https://project.example.com"],
      }),
    );

    const response = await worker.app.request(
      "/v1/stream/my-project/test-stream",
      {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          Origin: "https://project.example.com",
        },
      },
      { ...env, CORS_ORIGINS: "https://global.example.com" },
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://project.example.com");
  });

  it("wildcard in CORS_ORIGINS returns *", async () => {
    await env.REGISTRY.put(
      "_default",
      JSON.stringify({
        signingSecrets: ["test-secret"],
      }),
    );

    const response = await worker.app.request(
      "/v1/stream/test-stream",
      {
        method: "PUT",
        headers: { "Content-Type": "text/plain", Origin: "https://any.com" },
      },
      { ...env, CORS_ORIGINS: "*" },
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("multiple comma-separated global origins are parsed correctly", async () => {
    await env.REGISTRY.put(
      "_default",
      JSON.stringify({
        signingSecrets: ["test-secret"],
      }),
    );

    const response = await worker.app.request(
      "/v1/stream/test-stream",
      {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          Origin: "https://second.example.com",
        },
      },
      { ...env, CORS_ORIGINS: "https://first.example.com, https://second.example.com" },
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://second.example.com");
  });

  it("OPTIONS preflight uses global origins", async () => {
    const response = await worker.app.request(
      "/v1/stream/test-stream",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://global.example.com",
          "Access-Control-Request-Method": "POST",
        },
      },
      { ...env, CORS_ORIGINS: "https://global.example.com" },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://global.example.com");
  });

  it("no CORS headers when CORS_ORIGINS is empty string and no project origins", async () => {
    await env.REGISTRY.put(
      "_default",
      JSON.stringify({
        signingSecrets: ["test-secret"],
      }),
    );

    const response = await worker.app.request(
      "/v1/stream/test-stream",
      {
        method: "PUT",
        headers: { "Content-Type": "text/plain", Origin: "https://any.com" },
      },
      { ...env, CORS_ORIGINS: "" },
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("CORS with ?public=true query param", () => {
  const PROJECT = "cors-public-project";

  beforeEach(async () => {
    // No project entry in KV — mirrors production when corsOrigins
    // aren't configured. The ?public=true query param should be
    // sufficient to enable CORS with Access-Control-Allow-Origin: *.
    await env.REGISTRY.delete(PROJECT);
  });

  it("GET with ?public=true returns CORS headers even without KV corsOrigins", async () => {
    const w = createStreamWorker();

    const response = await w.app.request(
      `/v1/stream/${PROJECT}/some-stream?public=true&offset=-1`,
      {
        headers: { Origin: "https://any-origin.com" },
      },
      env,
    );

    // Auth may block (401) but CORS headers should still be present
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("OPTIONS preflight with ?public=true returns CORS headers even without KV corsOrigins", async () => {
    const w = createStreamWorker();

    const response = await w.app.request(
      `/v1/stream/${PROJECT}/some-stream?public=true`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://any-origin.com",
          "Access-Control-Request-Method": "GET",
        },
      },
      env,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
