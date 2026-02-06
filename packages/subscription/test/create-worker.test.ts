import { describe, it, expect, vi } from "vitest";
import type { AppEnv } from "../src/env";

// Mock cloudflare:workers (SubscriptionDO extends DurableObject)
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

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

function createBaseEnv(): AppEnv {
  return {
    CORE_URL: "http://localhost:8787",
    SUBSCRIPTION_DO: {
      idFromName: vi.fn().mockReturnValue("do-id"),
      get: vi.fn().mockReturnValue({ fetch: vi.fn() }),
    } as unknown as AppEnv["SUBSCRIPTION_DO"],
    METRICS: {} as AnalyticsEngineDataset,
  };
}

describe("createSubscriptionWorker", () => {
  it("no auth config — all requests allowed", async () => {
    const { createSubscriptionWorker } = await import("../src/http/create_worker");
    const worker = createSubscriptionWorker();
    const env = createBaseEnv();

    const response = await worker.fetch(
      new Request("http://localhost/health"),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("no auth config — API routes accessible without token", async () => {
    const { createSubscriptionWorker } = await import("../src/http/create_worker");
    const worker = createSubscriptionWorker();
    const env = { ...createBaseEnv(), AUTH_TOKEN: "secret" };

    // GET session should not be blocked (no auth configured)
    const response = await worker.fetch(
      new Request("http://localhost/v1/session/test-session"),
      env,
      {} as ExecutionContext,
    );

    // Will get 404 from the session handler (session doesn't exist), not 401
    expect(response.status).not.toBe(401);
  });

  it("custom auth — can reject requests", async () => {
    const { createSubscriptionWorker } = await import("../src/http/create_worker");
    const worker = createSubscriptionWorker({
      authorize: (_request, _route, _env) => {
        return { ok: false, response: new Response("forbidden", { status: 403 }) };
      },
    });
    const env = createBaseEnv();

    const response = await worker.fetch(
      new Request("http://localhost/v1/publish/my-stream", { method: "POST", body: "{}" }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(403);
  });

  it("custom auth — health check bypasses auth", async () => {
    const { createSubscriptionWorker } = await import("../src/http/create_worker");
    const worker = createSubscriptionWorker({
      authorize: () => ({
        ok: false,
        response: new Response("forbidden", { status: 403 }),
      }),
    });
    const env = createBaseEnv();

    const response = await worker.fetch(
      new Request("http://localhost/health"),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("custom auth — receives parsed route context", async () => {
    const { createSubscriptionWorker } = await import("../src/http/create_worker");
    let capturedRoute: unknown = null;

    const worker = createSubscriptionWorker({
      authorize: (_request, route, _env) => {
        capturedRoute = route;
        return { ok: true };
      },
    });
    const env = createBaseEnv();

    await worker.fetch(
      new Request("http://localhost/v1/publish/my-stream", { method: "POST", body: "{}" }),
      env,
      {} as ExecutionContext,
    );

    expect(capturedRoute).toEqual({ action: "publish", streamId: "my-stream" });
  });

  it("bearerTokenAuth — rejects without token", async () => {
    const { createSubscriptionWorker } = await import("../src/http/create_worker");
    const { bearerTokenAuth } = await import("../src/http/auth");

    const worker = createSubscriptionWorker({ authorize: bearerTokenAuth() });
    const env = { ...createBaseEnv(), AUTH_TOKEN: "secret" };

    const response = await worker.fetch(
      new Request("http://localhost/v1/publish/my-stream", { method: "POST", body: "{}" }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(401);
  });

  it("bearerTokenAuth — allows with correct token", async () => {
    const { createSubscriptionWorker } = await import("../src/http/create_worker");
    const { bearerTokenAuth } = await import("../src/http/auth");

    const worker = createSubscriptionWorker({ authorize: bearerTokenAuth() });
    const env = { ...createBaseEnv(), AUTH_TOKEN: "secret" };

    const response = await worker.fetch(
      new Request("http://localhost/v1/publish/my-stream", {
        method: "POST",
        body: "{}",
        headers: { Authorization: "Bearer secret" },
      }),
      env,
      {} as ExecutionContext,
    );

    // Should pass auth and hit the publish route (which will fail at DO layer, not auth)
    expect(response.status).not.toBe(401);
  });
});
