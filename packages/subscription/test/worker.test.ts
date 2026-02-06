import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppEnv } from "../src/env";

// Mock cloudflare:workers (worker uses WorkerEntrypoint + re-exports SubscriptionDO which extends DurableObject)
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {
    protected env: unknown;
    protected ctx: unknown;
    constructor(ctx?: unknown, env?: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
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

function createBaseEnv(overrides: Record<string, unknown> = {}) {
  return {
    CORE: {
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    },
    SUBSCRIPTION_DO: {
      idFromName: vi.fn().mockReturnValue("do-id"),
      get: vi.fn().mockReturnValue({ fetch: vi.fn() }),
    } as unknown as AppEnv["SUBSCRIPTION_DO"],
    METRICS: {} as AnalyticsEngineDataset,
    ...overrides,
  };
}

async function createTestWorker(env: Record<string, unknown>) {
  const { default: WorkerClass } = await import("../src/http/worker");
  return new WorkerClass({} as unknown as ExecutionContext, env as unknown as AppEnv);
}

describe("CORS configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows all origins by default (no CORS_ORIGINS set)", async () => {
    const env = createBaseEnv();
    const worker = await createTestWorker(env);
    const request = new Request("http://localhost/health", {
      headers: { Origin: "https://any-origin.com" },
    });

    const response = await worker.fetch(request);

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("uses CORS_ORIGINS from env when set to specific domain", async () => {
    const env = createBaseEnv({ CORS_ORIGINS: "https://example.com" });
    const worker = await createTestWorker(env);
    const request = new Request("http://localhost/health", {
      headers: { Origin: "https://example.com" },
    });

    const response = await worker.fetch(request);

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
  });

  it("supports comma-separated CORS_ORIGINS", async () => {
    const env = createBaseEnv({ CORS_ORIGINS: "https://example.com,https://test.com" });
    const worker = await createTestWorker(env);
    const request = new Request("http://localhost/health", {
      headers: { Origin: "https://test.com" },
    });

    const response = await worker.fetch(request);

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://test.com");
  });

  it("rejects origins not in CORS_ORIGINS list", async () => {
    const env = createBaseEnv({ CORS_ORIGINS: "https://example.com" });
    const worker = await createTestWorker(env);
    const request = new Request("http://localhost/health", {
      headers: { Origin: "https://evil.com" },
    });

    const response = await worker.fetch(request);

    // When origin is not allowed, CORS header is not set
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("allows all origins when CORS_ORIGINS is '*'", async () => {
    const env = createBaseEnv({ CORS_ORIGINS: "*" });
    const worker = await createTestWorker(env);
    const request = new Request("http://localhost/health", {
      headers: { Origin: "https://any-origin.com" },
    });

    const response = await worker.fetch(request);

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("handles OPTIONS preflight request", async () => {
    const env = createBaseEnv({ CORS_ORIGINS: "https://example.com" });
    const worker = await createTestWorker(env);
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok status", async () => {
    const env = createBaseEnv();
    const worker = await createTestWorker(env);
    const request = new Request("http://localhost/health");

    const response = await worker.fetch(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });
});
