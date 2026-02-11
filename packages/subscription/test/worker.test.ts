import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { AppEnv } from "../src/env";

const PROJECT_ID = "cors-test-project";

function createTestEnv(): AppEnv {
  return { ...env } as unknown as AppEnv;
}

async function createTestWorker() {
  const { createSubscriptionWorker } = await import("../src/http/create_worker");
  return createSubscriptionWorker();
}

describe("Per-project CORS from KV", () => {
  beforeEach(async () => {
    // Clean up KV between tests
    await env.REGISTRY.delete(PROJECT_ID);
  });

  it("non-project routes (/health) have no CORS headers", async () => {
    const worker = await createTestWorker();
    const response = await worker.fetch(
      new Request("http://localhost/health", {
        headers: { Origin: "https://any-origin.com" },
      }),
      createTestEnv(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("project routes with corsOrigins: ['*'] return wildcard", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({
      signingSecrets: ["test-secret"],
      corsOrigins: ["*"],
    }));

    const worker = await createTestWorker();
    const response = await worker.fetch(
      new Request(`http://localhost/v1/estuary/${PROJECT_ID}/test-estuary`, {
        headers: { Origin: "https://any-origin.com" },
      }),
      createTestEnv(),
      {} as ExecutionContext,
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("project routes with specific corsOrigins return matching origin", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({
      signingSecrets: ["test-secret"],
      corsOrigins: ["https://example.com", "https://test.com"],
    }));

    const worker = await createTestWorker();
    const response = await worker.fetch(
      new Request(`http://localhost/v1/estuary/${PROJECT_ID}/test-estuary`, {
        headers: { Origin: "https://test.com" },
      }),
      createTestEnv(),
      {} as ExecutionContext,
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://test.com");
  });

  it("project routes with no corsOrigins configured have no CORS headers", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({
      signingSecrets: ["test-secret"],
    }));

    const worker = await createTestWorker();
    const response = await worker.fetch(
      new Request(`http://localhost/v1/estuary/${PROJECT_ID}/test-estuary`, {
        headers: { Origin: "https://any-origin.com" },
      }),
      createTestEnv(),
      {} as ExecutionContext,
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("project routes with no KV entry have no CORS headers", async () => {
    const worker = await createTestWorker();
    const response = await worker.fetch(
      new Request(`http://localhost/v1/estuary/${PROJECT_ID}/test-estuary`, {
        headers: { Origin: "https://any-origin.com" },
      }),
      createTestEnv(),
      {} as ExecutionContext,
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("OPTIONS preflight at project paths returns CORS from KV", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({
      signingSecrets: ["test-secret"],
      corsOrigins: ["https://example.com"],
    }));

    const worker = await createTestWorker();
    const response = await worker.fetch(
      new Request(`http://localhost/v1/estuary/${PROJECT_ID}/test-estuary`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.com",
          "Access-Control-Request-Method": "POST",
        },
      }),
      createTestEnv(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("OPTIONS preflight at non-project paths has no CORS headers", async () => {
    const worker = await createTestWorker();
    const response = await worker.fetch(
      new Request("http://localhost/health", {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.com",
          "Access-Control-Request-Method": "GET",
        },
      }),
      createTestEnv(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("health check", () => {
  it("returns ok status", async () => {
    const worker = await createTestWorker();
    const response = await worker.fetch(
      new Request("http://localhost/health"),
      createTestEnv(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });
});
