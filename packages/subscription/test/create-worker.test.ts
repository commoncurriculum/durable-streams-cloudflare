import { describe, it, expect } from "vitest";
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

    // GET estuary should not be blocked (no auth configured)
    const response = await worker.fetch(
      new Request(`http://localhost/v1/estuary/${PROJECT_ID}/test-estuary`),
      createBaseEnv(),
      {} as ExecutionContext,
    );

    // Will get 404 from the estuary handler (estuary doesn't exist), not 401
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
      new Request(`http://localhost/v1/estuary/publish/${PROJECT_ID}/my-stream`, { method: "POST", body: "{}" }),
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
      new Request(`http://localhost/v1/estuary/publish/${PROJECT_ID}/my-stream`, { method: "POST", body: "{}" }),
      createBaseEnv(),
      {} as ExecutionContext,
    );

    expect(capturedRoute).toEqual({ action: "publish", project: PROJECT_ID, streamId: "my-stream" });
  });

  it("projectJwtAuth — rejects without token", async () => {
    const { createSubscriptionWorker } = await import("../src/http/create_worker");
    const { projectJwtAuth } = await import("../src/http/auth");

    const worker = createSubscriptionWorker({ authorize: projectJwtAuth() });
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({ signingSecret: "test-secret" }));

    const response = await worker.fetch(
      new Request(`http://localhost/v1/estuary/publish/${PROJECT_ID}/my-stream`, { method: "POST", body: "{}" }),
      createBaseEnv(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(401);
  });

  it("rejects invalid project IDs with 400", async () => {
    const { createSubscriptionWorker } = await import("../src/http/create_worker");
    const worker = createSubscriptionWorker();

    const response = await worker.fetch(
      new Request("http://localhost/v1/estuary/publish/bad%20project!/my-stream", { method: "POST", body: "{}" }),
      createBaseEnv(),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({ error: "Invalid project ID" });
  });

  it("projectJwtAuth — rejects with 500 when REGISTRY missing", async () => {
    const { createSubscriptionWorker } = await import("../src/http/create_worker");
    const { projectJwtAuth } = await import("../src/http/auth");

    const worker = createSubscriptionWorker({ authorize: projectJwtAuth() });

    // Construct env without REGISTRY to trigger the 500 path
    const { REGISTRY: _, ...envWithoutKeys } = createBaseEnv();
    const response = await worker.fetch(
      new Request(`http://localhost/v1/estuary/publish/${PROJECT_ID}/my-stream`, {
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
