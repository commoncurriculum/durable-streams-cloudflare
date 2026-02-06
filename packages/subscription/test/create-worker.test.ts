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

const PROJECT_ID = "test-project";

function createBaseEnv(): AppEnv {
  return {
    CORE: {
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    },
    SUBSCRIPTION_DO: {
      idFromName: vi.fn().mockReturnValue("do-id"),
      get: vi.fn().mockReturnValue({ fetch: vi.fn() }),
    } as unknown as AppEnv["SUBSCRIPTION_DO"],
    METRICS: {} as AnalyticsEngineDataset,
  } as unknown as AppEnv;
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
      new Request(`http://localhost/v1/${PROJECT_ID}/session/test-session`),
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
      new Request(`http://localhost/v1/${PROJECT_ID}/publish/my-stream`, { method: "POST", body: "{}" }),
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
      new Request(`http://localhost/v1/${PROJECT_ID}/publish/my-stream`, { method: "POST", body: "{}" }),
      env,
      {} as ExecutionContext,
    );

    expect(capturedRoute).toEqual({ action: "publish", project: PROJECT_ID, streamId: "my-stream" });
  });

  it("bearerTokenAuth — rejects without token", async () => {
    const { createSubscriptionWorker } = await import("../src/http/create_worker");
    const { bearerTokenAuth } = await import("../src/http/auth");

    const worker = createSubscriptionWorker({ authorize: bearerTokenAuth() });
    const env = { ...createBaseEnv(), AUTH_TOKEN: "secret" };

    const response = await worker.fetch(
      new Request(`http://localhost/v1/${PROJECT_ID}/publish/my-stream`, { method: "POST", body: "{}" }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(401);
  });

  it("rejects invalid project IDs with 400", async () => {
    const { createSubscriptionWorker } = await import("../src/http/create_worker");
    const worker = createSubscriptionWorker();
    const env = createBaseEnv();

    const response = await worker.fetch(
      new Request("http://localhost/v1/bad%20project!/publish/my-stream", { method: "POST", body: "{}" }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({ error: "Invalid project ID" });
  });

  it("bearerTokenAuth — allows with correct token", async () => {
    const { createSubscriptionWorker } = await import("../src/http/create_worker");
    const { bearerTokenAuth } = await import("../src/http/auth");

    const worker = createSubscriptionWorker({ authorize: bearerTokenAuth() });
    const env = { ...createBaseEnv(), AUTH_TOKEN: "secret" };

    const response = await worker.fetch(
      new Request(`http://localhost/v1/${PROJECT_ID}/publish/my-stream`, {
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
