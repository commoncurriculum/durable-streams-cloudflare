import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { SignJWT, UnsecuredJWT } from "jose";
import {
  projectJwtAuth,
  extractBearerToken,
  verifyProjectJwt,
  verifyProjectJwtMultiKey,
  lookupProjectConfig,
  decodeJwtPayloadUnsafe,
} from "../../../src/http/auth";
import type { ProjectConfig } from "../../../src/http/auth";

// ============================================================================
// JWT Test Helpers
// ============================================================================

async function createTestJwt(
  claims: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT(claims as Record<string, unknown>)
    .setProtectedHeader(header as { alg: string; typ?: string })
    .sign(key);
}

function makeRequest(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("http://localhost/v1/stream/myproject/test-stream", { headers });
}

const SECRET = "test-signing-secret-for-hmac-256";
const PROJECT_ID = "myproject";

function validClaims(overrides?: Record<string, unknown>) {
  return {
    sub: PROJECT_ID,
    scope: "write",
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("extractBearerToken", () => {
  it("extracts token from valid header", () => {
    const request = new Request("http://localhost", {
      headers: { Authorization: "Bearer my-token" },
    });
    expect(extractBearerToken(request)).toBe("my-token");
  });

  it("returns null when no Authorization header", () => {
    const request = new Request("http://localhost");
    expect(extractBearerToken(request)).toBeNull();
  });

  it("returns null for non-Bearer scheme", () => {
    const request = new Request("http://localhost", {
      headers: { Authorization: "Basic abc123" },
    });
    expect(extractBearerToken(request)).toBeNull();
  });
});

describe("decodeJwtPayloadUnsafe", () => {
  it("decodes payload without verifying", async () => {
    const token = await createTestJwt({ sub: "test", scope: "write", exp: 123 }, SECRET);
    const payload = decodeJwtPayloadUnsafe(token);
    expect(payload).toEqual({ sub: "test", scope: "write", exp: 123 });
  });

  it("returns null for malformed token", () => {
    expect(decodeJwtPayloadUnsafe("not-a-jwt")).toBeNull();
  });
});

describe("verifyProjectJwt", () => {
  it("verifies a valid JWT", async () => {
    const token = await createTestJwt(validClaims(), SECRET);
    const claims = await verifyProjectJwt(token, SECRET);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe(PROJECT_ID);
    expect(claims!.scope).toBe("write");
  });

  it("rejects JWT signed with wrong secret", async () => {
    const token = await createTestJwt(validClaims(), "wrong-secret");
    const claims = await verifyProjectJwt(token, SECRET);
    expect(claims).toBeNull();
  });

  it("rejects JWT with non-HS256 algorithm", async () => {
    const token = new UnsecuredJWT(validClaims()).encode();
    const claims = await verifyProjectJwt(token, SECRET);
    expect(claims).toBeNull();
  });

  it("rejects JWT with missing sub", async () => {
    const token = await createTestJwt({ scope: "write", exp: Date.now() / 1000 + 3600 }, SECRET);
    const claims = await verifyProjectJwt(token, SECRET);
    expect(claims).toBeNull();
  });

  it("rejects JWT with invalid scope", async () => {
    const token = await createTestJwt(validClaims({ scope: "admin" }), SECRET);
    const claims = await verifyProjectJwt(token, SECRET);
    expect(claims).toBeNull();
  });

  it("accepts read scope", async () => {
    const token = await createTestJwt(validClaims({ scope: "read" }), SECRET);
    const claims = await verifyProjectJwt(token, SECRET);
    expect(claims).not.toBeNull();
    expect(claims!.scope).toBe("read");
  });

  it("returns stream_id when present", async () => {
    const token = await createTestJwt(validClaims({ stream_id: "my-stream" }), SECRET);
    const claims = await verifyProjectJwt(token, SECRET);
    expect(claims).not.toBeNull();
    expect(claims!.stream_id).toBe("my-stream");
  });
});

describe("lookupProjectConfig", () => {
  it("reads legacy signingSecret format and normalizes to array", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({ signingSecrets: [SECRET] }));
    const config = await lookupProjectConfig(env.REGISTRY, PROJECT_ID);
    expect(config).toEqual({ signingSecrets: [SECRET] });
  });

  it("reads new signingSecrets array format", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({ signingSecrets: ["key-a", "key-b"] }));
    const config = await lookupProjectConfig(env.REGISTRY, PROJECT_ID);
    expect(config).toEqual({ signingSecrets: ["key-a", "key-b"] });
  });

  it("returns null when project does not exist", async () => {
    await env.REGISTRY.delete(PROJECT_ID);
    const config = await lookupProjectConfig(env.REGISTRY, PROJECT_ID);
    expect(config).toBeNull();
  });

  it("returns null for empty signingSecrets array", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({ signingSecrets: [] }));
    const config = await lookupProjectConfig(env.REGISTRY, PROJECT_ID);
    expect(config).toBeNull();
  });

  it("returns null for invalid value", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({ unrelated: true }));
    const config = await lookupProjectConfig(env.REGISTRY, PROJECT_ID);
    expect(config).toBeNull();
  });
});

describe("projectJwtAuth - authorizeMutation", () => {
  const { authorizeMutation } = projectJwtAuth();

  beforeEach(async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({ signingSecrets: [SECRET] }));
  });

  it("rejects with 500 when REGISTRY not configured", async () => {
    const result = await authorizeMutation(makeRequest("token"), "myproject/test", {} as any, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.status).toBe(500);
  });

  it("rejects with 401 when no token provided", async () => {
    const result = await authorizeMutation(makeRequest(), "myproject/test", { REGISTRY: env.REGISTRY }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects with 401 when project not found in KV", async () => {
    await env.REGISTRY.delete(PROJECT_ID);
    const token = await createTestJwt(validClaims(), SECRET);
    const result = await authorizeMutation(makeRequest(token), "myproject/test", { REGISTRY: env.REGISTRY }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects with 401 when JWT signature is invalid", async () => {
    const token = await createTestJwt(validClaims(), "wrong-secret");
    const result = await authorizeMutation(makeRequest(token), "myproject/test", { REGISTRY: env.REGISTRY }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects with 403 when sub does not match project", async () => {
    const token = await createTestJwt(validClaims({ sub: "other-project" }), SECRET);
    const result = await authorizeMutation(makeRequest(token), "myproject/test", { REGISTRY: env.REGISTRY }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("rejects with 401 when token is expired", async () => {
    const token = await createTestJwt(validClaims({ exp: Math.floor(Date.now() / 1000) - 60 }), SECRET);
    const result = await authorizeMutation(makeRequest(token), "myproject/test", { REGISTRY: env.REGISTRY }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects with 403 when scope is read", async () => {
    const token = await createTestJwt(validClaims({ scope: "read" }), SECRET);
    const result = await authorizeMutation(makeRequest(token), "myproject/test", { REGISTRY: env.REGISTRY }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("allows valid write JWT", async () => {
    const token = await createTestJwt(validClaims(), SECRET);
    const result = await authorizeMutation(makeRequest(token), "myproject/test", { REGISTRY: env.REGISTRY }, null);
    expect(result).toEqual({ ok: true });
  });

  it("rejects when doKey has no slash (maps to _default project, no config)", async () => {
    const token = await createTestJwt(validClaims(), SECRET);
    const result = await authorizeMutation(makeRequest(token), "no-slash", { REGISTRY: env.REGISTRY }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.status).toBe(401);
  });
});

describe("projectJwtAuth - authorizeRead", () => {
  const { authorizeRead } = projectJwtAuth();

  beforeEach(async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({ signingSecrets: [SECRET] }));
  });

  it("rejects with 500 when REGISTRY not configured", async () => {
    const result = await authorizeRead(makeRequest("token"), "myproject/test", {} as any, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.status).toBe(500);
  });

  it("rejects with 401 when no token", async () => {
    const result = await authorizeRead(makeRequest(), "myproject/test", { REGISTRY: env.REGISTRY }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it("allows valid read JWT", async () => {
    const token = await createTestJwt(validClaims({ scope: "read" }), SECRET);
    const result = await authorizeRead(makeRequest(token), "myproject/test", { REGISTRY: env.REGISTRY }, null);
    expect(result).toHaveProperty("ok", true);
  });

  it("allows valid write JWT for reads", async () => {
    const token = await createTestJwt(validClaims({ scope: "write" }), SECRET);
    const result = await authorizeRead(makeRequest(token), "myproject/test", { REGISTRY: env.REGISTRY }, null);
    expect(result).toHaveProperty("ok", true);
  });

  it("rejects with 403 when stream_id does not match", async () => {
    const token = await createTestJwt(validClaims({ scope: "read", stream_id: "other-stream" }), SECRET);
    const result = await authorizeRead(makeRequest(token), "myproject/test-stream", { REGISTRY: env.REGISTRY }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) {
      expect(result.status).toBe(403);
    }
  });

  it("allows when stream_id matches", async () => {
    const token = await createTestJwt(validClaims({ scope: "read", stream_id: "test-stream" }), SECRET);
    const result = await authorizeRead(makeRequest(token), "myproject/test-stream", { REGISTRY: env.REGISTRY }, null);
    expect(result).toHaveProperty("ok", true);
  });

  it("rejects with 403 when sub does not match project", async () => {
    const token = await createTestJwt(validClaims({ sub: "wrong" }), SECRET);
    const result = await authorizeRead(makeRequest(token), "myproject/test", { REGISTRY: env.REGISTRY }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) {
      expect(result.status).toBe(403);
    }
  });
});

// ============================================================================
// Multi-Key Verification
// ============================================================================

const OLD_SECRET = "old-signing-secret-for-rotation";
const NEW_SECRET = "new-signing-secret-for-rotation";

describe("verifyProjectJwtMultiKey", () => {
  it("verifies against primary key", async () => {
    const config: ProjectConfig = { signingSecrets: [NEW_SECRET, OLD_SECRET] };
    const token = await createTestJwt(validClaims(), NEW_SECRET);
    const claims = await verifyProjectJwtMultiKey(token, config);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe(PROJECT_ID);
  });

  it("verifies against rotated old key", async () => {
    const config: ProjectConfig = { signingSecrets: [NEW_SECRET, OLD_SECRET] };
    const token = await createTestJwt(validClaims(), OLD_SECRET);
    const claims = await verifyProjectJwtMultiKey(token, config);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe(PROJECT_ID);
  });

  it("rejects unknown key", async () => {
    const config: ProjectConfig = { signingSecrets: [NEW_SECRET, OLD_SECRET] };
    const token = await createTestJwt(validClaims(), "totally-unknown-secret");
    const claims = await verifyProjectJwtMultiKey(token, config);
    expect(claims).toBeNull();
  });
});

describe("projectJwtAuth - key rotation", () => {
  const { authorizeMutation, authorizeRead } = projectJwtAuth();

  it("allows old key during rotation (authorizeMutation)", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({ signingSecrets: [NEW_SECRET, OLD_SECRET] }));
    const token = await createTestJwt(validClaims(), OLD_SECRET);
    const result = await authorizeMutation(makeRequest(token), "myproject/test", { REGISTRY: env.REGISTRY }, null);
    expect(result).toEqual({ ok: true });
  });

  it("allows new primary key (authorizeMutation)", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({ signingSecrets: [NEW_SECRET, OLD_SECRET] }));
    const token = await createTestJwt(validClaims(), NEW_SECRET);
    const result = await authorizeMutation(makeRequest(token), "myproject/test", { REGISTRY: env.REGISTRY }, null);
    expect(result).toEqual({ ok: true });
  });

  it("allows old key during rotation (authorizeRead)", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({ signingSecrets: [NEW_SECRET, OLD_SECRET] }));
    const token = await createTestJwt(validClaims({ scope: "read" }), OLD_SECRET);
    const result = await authorizeRead(makeRequest(token), "myproject/test", { REGISTRY: env.REGISTRY }, null);
    expect(result).toHaveProperty("ok", true);
  });

  it("works with legacy format (authorizeMutation)", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({ signingSecret: SECRET }));
    const token = await createTestJwt(validClaims(), SECRET);
    const result = await authorizeMutation(makeRequest(token), "myproject/test", { REGISTRY: env.REGISTRY }, null);
    expect(result).toEqual({ ok: true });
  });

  it("works with legacy format (authorizeRead)", async () => {
    await env.REGISTRY.put(PROJECT_ID, JSON.stringify({ signingSecret: SECRET }));
    const token = await createTestJwt(validClaims({ scope: "read" }), SECRET);
    const result = await authorizeRead(makeRequest(token), "myproject/test", { REGISTRY: env.REGISTRY }, null);
    expect(result).toHaveProperty("ok", true);
  });
});
