import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { SignJWT } from "jose";
import {
  extractBearerToken,
  verifyProjectJwt,
  verifyProjectJwtMultiKey,
  lookupProjectConfig,
} from "../../../../src/http/middleware/authentication";
import type { ProjectConfig } from "../../../../src/http/middleware/authentication";

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
