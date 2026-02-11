import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SignJWT } from "jose";
import { createStreamWorker } from "../../../src/http";
import type { BaseEnv } from "../../../src/http";

// ============================================================================
// JWT Test Helpers
// ============================================================================

async function createTestJwt(
  claims: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(key);
}

// ============================================================================
// Constants
// ============================================================================

const SECRET = "test-signing-secret-for-hmac-256";
const PROJECT_ID = "myproject";

function manageClaims(overrides?: Record<string, unknown>) {
  return {
    sub: PROJECT_ID,
    scope: "manage",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function makeEnv(): BaseEnv {
  return { ...env } as unknown as BaseEnv;
}

function makeCtx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

async function fetchConfig(
  worker: ReturnType<typeof createStreamWorker>,
  method: string,
  token?: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  return worker.fetch!(
    new Request(`http://localhost/v1/config/${PROJECT_ID}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }) as unknown as Request<unknown, IncomingRequestCfProperties>,
    makeEnv(),
    makeCtx(),
  );
}

// ============================================================================
// Tests
// ============================================================================

describe("Config API - Auth", () => {
  let worker: ReturnType<typeof createStreamWorker>;

  beforeEach(async () => {
    worker = createStreamWorker();
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({
      signingSecrets: [SECRET],
      corsOrigins: ["https://example.com"],
      isPublic: false,
    }));
  });

  it("rejects with 401 when no token provided", async () => {
    const response = await fetchConfig(worker, "GET");
    expect(response.status).toBe(401);
  });

  it("rejects with 401 when token is invalid", async () => {
    const token = await createTestJwt(manageClaims(), "wrong-secret");
    const response = await fetchConfig(worker, "GET", token);
    expect(response.status).toBe(401);
  });

  it("rejects with 403 when scope is read", async () => {
    const token = await createTestJwt(manageClaims({ scope: "read" }), SECRET);
    const response = await fetchConfig(worker, "GET", token);
    expect(response.status).toBe(403);
  });

  it("rejects with 403 when scope is write", async () => {
    const token = await createTestJwt(manageClaims({ scope: "write" }), SECRET);
    const response = await fetchConfig(worker, "GET", token);
    expect(response.status).toBe(403);
  });

  it("rejects with 403 when sub does not match projectId", async () => {
    const token = await createTestJwt(manageClaims({ sub: "other-project" }), SECRET);
    const response = await fetchConfig(worker, "GET", token);
    expect(response.status).toBe(403);
  });

  it("rejects with 401 when token is expired", async () => {
    const token = await createTestJwt(manageClaims({ exp: Math.floor(Date.now() / 1000) - 60 }), SECRET);
    const response = await fetchConfig(worker, "GET", token);
    expect(response.status).toBe(401);
  });

  it("rejects with 401 when project does not exist in KV", async () => {
    await env.REGISTRY.delete(PROJECT_ID);
    const token = await createTestJwt(manageClaims(), SECRET);
    const response = await fetchConfig(worker, "GET", token);
    expect(response.status).toBe(401);
  });
});

describe("Config API - GET /v1/config/:projectId", () => {
  let worker: ReturnType<typeof createStreamWorker>;

  beforeEach(async () => {
    worker = createStreamWorker();
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({
      signingSecrets: [SECRET],
      corsOrigins: ["https://example.com"],
      isPublic: true,
    }));
  });

  it("returns project config", async () => {
    const token = await createTestJwt(manageClaims(), SECRET);
    const response = await fetchConfig(worker, "GET", token);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      signingSecrets: [SECRET],
      corsOrigins: ["https://example.com"],
      isPublic: true,
    });
  });

  it("returns defaults for missing optional fields", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({
      signingSecrets: [SECRET],
    }));
    const token = await createTestJwt(manageClaims(), SECRET);
    const response = await fetchConfig(worker, "GET", token);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      signingSecrets: [SECRET],
      corsOrigins: [],
      isPublic: false,
    });
  });
});

describe("Config API - PUT /v1/config/:projectId", () => {
  let worker: ReturnType<typeof createStreamWorker>;

  beforeEach(async () => {
    worker = createStreamWorker();
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({
      signingSecrets: [SECRET],
    }));
  });

  it("updates project config", async () => {
    const token = await createTestJwt(manageClaims(), SECRET);
    const newConfig = {
      signingSecrets: [SECRET, "new-secret"],
      corsOrigins: ["https://new-origin.com"],
      isPublic: true,
    };
    const response = await fetchConfig(worker, "PUT", token, newConfig);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ ok: true });

    // Verify KV was updated
    const stored = await env.REGISTRY.get(PROJECT_ID, "json") as Record<string, unknown>;
    expect(stored.signingSecrets).toEqual([SECRET, "new-secret"]);
    expect(stored.corsOrigins).toEqual(["https://new-origin.com"]);
    expect(stored.isPublic).toBe(true);
  });

  it("rejects empty signingSecrets array", async () => {
    const token = await createTestJwt(manageClaims(), SECRET);
    const response = await fetchConfig(worker, "PUT", token, {
      signingSecrets: [],
      corsOrigins: [],
    });
    expect(response.status).toBe(400);
  });

  it("rejects missing signingSecrets", async () => {
    const token = await createTestJwt(manageClaims(), SECRET);
    const response = await fetchConfig(worker, "PUT", token, {
      corsOrigins: ["https://example.com"],
    });
    expect(response.status).toBe(400);
  });

  it("accepts config with only required fields", async () => {
    const token = await createTestJwt(manageClaims(), SECRET);
    const response = await fetchConfig(worker, "PUT", token, {
      signingSecrets: ["only-secret"],
    });
    expect(response.status).toBe(200);

    const stored = await env.REGISTRY.get(PROJECT_ID, "json") as Record<string, unknown>;
    expect(stored.signingSecrets).toEqual(["only-secret"]);
  });
});

describe("Config API - routing", () => {
  let worker: ReturnType<typeof createStreamWorker>;

  beforeEach(async () => {
    worker = createStreamWorker();
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({
      signingSecrets: [SECRET],
    }));
  });

  it("returns 404 for non-matching paths", async () => {
    const token = await createTestJwt(manageClaims(), SECRET);
    const response = await worker.fetch!(
      new Request("http://localhost/v1/config/", {
        headers: { Authorization: `Bearer ${token}` },
      }) as unknown as Request<unknown, IncomingRequestCfProperties>,
      makeEnv(),
      makeCtx(),
    );
    expect(response.status).toBe(404);
  });

  it("rejects invalid project id characters", async () => {
    const token = await createTestJwt(manageClaims({ sub: "bad project!" }), SECRET);
    const response = await worker.fetch!(
      new Request("http://localhost/v1/config/bad%20project!", {
        headers: { Authorization: `Bearer ${token}` },
      }) as unknown as Request<unknown, IncomingRequestCfProperties>,
      makeEnv(),
      makeCtx(),
    );
    expect(response.status).toBe(400);
  });
});
