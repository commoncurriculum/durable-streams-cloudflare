import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppEnv } from "../src/env";

// Mock cloudflare:workers (worker re-exports SubscriptionDO which extends DurableObject)
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

// Mock dependencies
vi.mock("../src/metrics", () => ({
  createMetrics: vi.fn(() => ({
    http: vi.fn(),
    cleanupBatch: vi.fn(),
  })),
}));

vi.mock("../src/cleanup", () => ({
  cleanupExpiredSessions: vi.fn().mockResolvedValue({
    deleted: 0,
    streamDeleteSuccesses: 0,
    streamDeleteFailures: 0,
    subscriptionRemoveSuccesses: 0,
    subscriptionRemoveFailures: 0,
  }),
}));

function createBaseEnv() {
  return {
    CORE_URL: "http://localhost:8787",
    SUBSCRIPTION_DO: {
      idFromName: vi.fn().mockReturnValue("do-id"),
      get: vi.fn().mockReturnValue({ fetch: vi.fn() }),
    } as unknown as AppEnv["SUBSCRIPTION_DO"],
    METRICS: {} as AnalyticsEngineDataset,
  };
}

async function createTestWorker() {
  const { default: worker } = await import("../src/http/worker");
  return worker;
}

describe("CORS configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows all origins by default (no CORS_ORIGINS set)", async () => {
    const worker = await createTestWorker();
    const env = createBaseEnv();
    const request = new Request("http://localhost/health", {
      headers: { Origin: "https://any-origin.com" },
    });

    const response = await worker.fetch(request, env, {} as ExecutionContext);

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("uses CORS_ORIGINS from env when set to specific domain", async () => {
    const worker = await createTestWorker();
    const env = {
      ...createBaseEnv(),
      CORS_ORIGINS: "https://example.com",
    };
    const request = new Request("http://localhost/health", {
      headers: { Origin: "https://example.com" },
    });

    const response = await worker.fetch(request, env, {} as ExecutionContext);

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
  });

  it("supports comma-separated CORS_ORIGINS", async () => {
    const worker = await createTestWorker();
    const env = {
      ...createBaseEnv(),
      CORS_ORIGINS: "https://example.com,https://test.com",
    };
    const request = new Request("http://localhost/health", {
      headers: { Origin: "https://test.com" },
    });

    const response = await worker.fetch(request, env, {} as ExecutionContext);

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://test.com");
  });

  it("rejects origins not in CORS_ORIGINS list", async () => {
    const worker = await createTestWorker();
    const env = {
      ...createBaseEnv(),
      CORS_ORIGINS: "https://example.com",
    };
    const request = new Request("http://localhost/health", {
      headers: { Origin: "https://evil.com" },
    });

    const response = await worker.fetch(request, env, {} as ExecutionContext);

    // When origin is not allowed, CORS header is not set
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("allows all origins when CORS_ORIGINS is '*'", async () => {
    const worker = await createTestWorker();
    const env = {
      ...createBaseEnv(),
      CORS_ORIGINS: "*",
    };
    const request = new Request("http://localhost/health", {
      headers: { Origin: "https://any-origin.com" },
    });

    const response = await worker.fetch(request, env, {} as ExecutionContext);

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("handles OPTIONS preflight request", async () => {
    const worker = await createTestWorker();
    const env = {
      ...createBaseEnv(),
      CORS_ORIGINS: "https://example.com",
    };
    const request = new Request("http://localhost/health", {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "POST",
      },
    });

    const response = await worker.fetch(request, env, {} as ExecutionContext);

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});

describe("health check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok status", async () => {
    const worker = await createTestWorker();
    const env = createBaseEnv();
    const request = new Request("http://localhost/health");

    const response = await worker.fetch(request, env, {} as ExecutionContext);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });
});
