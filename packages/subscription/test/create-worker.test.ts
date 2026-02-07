import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { AppEnv } from "../src/env";

const PROJECT_ID = "test-project";

function createBaseEnv(): AppEnv {
  return { ...env } as unknown as AppEnv;
}

describe("createSubscriptionWorker", () => {
  it("no auth config — all requests allowed", async () => {
    const { createSubscriptionWorker } = await import("../src/http/create_worker");
    const worker = createSubscriptionWorker();

    const response = await worker.fetch(
      new Request("http://localhost/health"),
      createBaseEnv(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("no auth config — API routes accessible without token", async () => {
    const { createSubscriptionWorker } = await import("../src/http/create_worker");
    const worker = createSubscriptionWorker();

    // GET session should not be blocked (no auth configured)
    const response = await worker.fetch(
      new Request(`http://localhost/v1/${PROJECT_ID}/session/test-session`),
      createBaseEnv(),
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

    const response = await worker.fetch(
      new Request(`http://localhost/v1/${PROJECT_ID}/publish/my-stream`, { method: "POST", body: "{}" }),
      createBaseEnv(),
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

    const response = await worker.fetch(
      new Request("http://localhost/health"),
      createBaseEnv(),
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

    await worker.fetch(
      new Request(`http://localhost/v1/${PROJECT_ID}/publish/my-stream`, { method: "POST", body: "{}" }),
      createBaseEnv(),
      {} as ExecutionContext,
    );

    expect(capturedRoute).toEqual({ action: "publish", project: PROJECT_ID, streamId: "my-stream" });
  });

  it("projectJwtAuth — rejects without token", async () => {
    const { createSubscriptionWorker } = await import("../src/http/create_worker");
    const { projectJwtAuth } = await import("../src/http/auth");

    const worker = createSubscriptionWorker({ authorize: projectJwtAuth() });
    const testEnv = {
      ...createBaseEnv(),
      PROJECT_KEYS: {
        get: vi.fn().mockResolvedValue(JSON.stringify({ signingSecret: "test-secret" })),
      } as unknown as KVNamespace,
    };

    const response = await worker.fetch(
      new Request(`http://localhost/v1/${PROJECT_ID}/publish/my-stream`, { method: "POST", body: "{}" }),
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(401);
  });

  it("rejects invalid project IDs with 400", async () => {
    const { createSubscriptionWorker } = await import("../src/http/create_worker");
    const worker = createSubscriptionWorker();

    const response = await worker.fetch(
      new Request("http://localhost/v1/bad%20project!/publish/my-stream", { method: "POST", body: "{}" }),
      createBaseEnv(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({ error: "Invalid project ID" });
  });

  it("projectJwtAuth — rejects with 500 when PROJECT_KEYS missing", async () => {
    const { createSubscriptionWorker } = await import("../src/http/create_worker");
    const { projectJwtAuth } = await import("../src/http/auth");

    const worker = createSubscriptionWorker({ authorize: projectJwtAuth() });

    // Construct env without PROJECT_KEYS to trigger the 500 path
    const { PROJECT_KEYS: _, ...envWithoutKeys } = createBaseEnv();
    const response = await worker.fetch(
      new Request(`http://localhost/v1/${PROJECT_ID}/publish/my-stream`, {
        method: "POST",
        body: "{}",
        headers: { Authorization: "Bearer some-token" },
      }),
      envWithoutKeys as AppEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(500);
  });
});
