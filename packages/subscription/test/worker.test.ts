import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { AppEnv } from "../src/env";

function createTestEnv(overrides: Record<string, unknown> = {}): AppEnv {
  return { ...env, ...overrides } as unknown as AppEnv;
}

async function createTestWorker(testEnv: AppEnv) {
  const { default: WorkerClass } = await import("../src/http/worker");
  return new WorkerClass({} as unknown as ExecutionContext, testEnv);
}

describe("CORS configuration", () => {
  it("allows all origins by default (no CORS_ORIGINS set)", async () => {
    const worker = await createTestWorker(createTestEnv());
    const request = new Request("http://localhost/health", {
      headers: { Origin: "https://any-origin.com" },
    });

    const response = await worker.fetch(request);

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("uses CORS_ORIGINS from env when set to specific domain", async () => {
    const worker = await createTestWorker(createTestEnv({ CORS_ORIGINS: "https://example.com" }));
    const request = new Request("http://localhost/health", {
      headers: { Origin: "https://example.com" },
    });

    const response = await worker.fetch(request);

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
  });

  it("supports comma-separated CORS_ORIGINS", async () => {
    const worker = await createTestWorker(createTestEnv({ CORS_ORIGINS: "https://example.com,https://test.com" }));
    const request = new Request("http://localhost/health", {
      headers: { Origin: "https://test.com" },
    });

    const response = await worker.fetch(request);

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://test.com");
  });

  it("rejects origins not in CORS_ORIGINS list", async () => {
    const worker = await createTestWorker(createTestEnv({ CORS_ORIGINS: "https://example.com" }));
    const request = new Request("http://localhost/health", {
      headers: { Origin: "https://evil.com" },
    });

    const response = await worker.fetch(request);

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("allows all origins when CORS_ORIGINS is '*'", async () => {
    const worker = await createTestWorker(createTestEnv({ CORS_ORIGINS: "*" }));
    const request = new Request("http://localhost/health", {
      headers: { Origin: "https://any-origin.com" },
    });

    const response = await worker.fetch(request);

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("handles OPTIONS preflight request", async () => {
    const worker = await createTestWorker(createTestEnv({ CORS_ORIGINS: "https://example.com" }));
    const request = new Request("http://localhost/health", {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "POST",
      },
    });

    const response = await worker.fetch(request);

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});

describe("health check", () => {
  it("returns ok status", async () => {
    const worker = await createTestWorker(createTestEnv());
    const request = new Request("http://localhost/health");

    const response = await worker.fetch(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });
});
