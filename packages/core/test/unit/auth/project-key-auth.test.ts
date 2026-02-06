import { describe, it, expect, vi } from "vitest";
import {
  projectJwtAuth,
  extractBearerToken,
  verifyProjectJwt,
  lookupProjectConfig,
  decodeJwtPayloadUnsafe,
} from "../../../src/http/auth";

// ============================================================================
// JWT Test Helpers
// ============================================================================

function base64UrlEncode(data: Uint8Array): string {
  const binary = String.fromCharCode(...data);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createTestJwt(
  claims: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): Promise<string> {
  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  const signatureB64 = base64UrlEncode(new Uint8Array(signature));

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

function makeRequest(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("http://localhost/v1/myproject/stream/test-stream", { headers });
}

function createMockKV(data: Record<string, unknown>): KVNamespace {
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const value = data[key];
      if (value === undefined) return null;
      if (type === "json") return value;
      return JSON.stringify(value);
    }),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
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
    const token = await createTestJwt(validClaims(), SECRET, { alg: "none", typ: "JWT" });
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
  it("returns config when project exists", async () => {
    const kv = createMockKV({ [PROJECT_ID]: { signingSecret: SECRET } });
    const config = await lookupProjectConfig(kv, PROJECT_ID);
    expect(config).toEqual({ signingSecret: SECRET });
  });

  it("returns null when project does not exist", async () => {
    const kv = createMockKV({});
    const config = await lookupProjectConfig(kv, PROJECT_ID);
    expect(config).toBeNull();
  });
});

describe("projectJwtAuth - authorizeMutation", () => {
  const { authorizeMutation } = projectJwtAuth();

  it("rejects with 500 when PROJECT_KEYS not configured", async () => {
    const result = await authorizeMutation(makeRequest("token"), "myproject/test", {} as any, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(500);
  });

  it("rejects with 401 when no token provided", async () => {
    const kv = createMockKV({ [PROJECT_ID]: { signingSecret: SECRET } });
    const result = await authorizeMutation(makeRequest(), "myproject/test", { PROJECT_KEYS: kv }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("rejects with 401 when project not found in KV", async () => {
    const kv = createMockKV({});
    const token = await createTestJwt(validClaims(), SECRET);
    const result = await authorizeMutation(makeRequest(token), "myproject/test", { PROJECT_KEYS: kv }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("rejects with 401 when JWT signature is invalid", async () => {
    const kv = createMockKV({ [PROJECT_ID]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims(), "wrong-secret");
    const result = await authorizeMutation(makeRequest(token), "myproject/test", { PROJECT_KEYS: kv }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("rejects with 403 when sub does not match project", async () => {
    const kv = createMockKV({ [PROJECT_ID]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ sub: "other-project" }), SECRET);
    const result = await authorizeMutation(makeRequest(token), "myproject/test", { PROJECT_KEYS: kv }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("rejects with 401 when token is expired", async () => {
    const kv = createMockKV({ [PROJECT_ID]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ exp: Math.floor(Date.now() / 1000) - 60 }), SECRET);
    const result = await authorizeMutation(makeRequest(token), "myproject/test", { PROJECT_KEYS: kv }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("rejects with 403 when scope is read", async () => {
    const kv = createMockKV({ [PROJECT_ID]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ scope: "read" }), SECRET);
    const result = await authorizeMutation(makeRequest(token), "myproject/test", { PROJECT_KEYS: kv }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("allows valid write JWT", async () => {
    const kv = createMockKV({ [PROJECT_ID]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims(), SECRET);
    const result = await authorizeMutation(makeRequest(token), "myproject/test", { PROJECT_KEYS: kv }, null);
    expect(result).toEqual({ ok: true });
  });

  it("rejects with 403 when doKey has no slash", async () => {
    const kv = createMockKV({ [PROJECT_ID]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims(), SECRET);
    const result = await authorizeMutation(makeRequest(token), "no-slash", { PROJECT_KEYS: kv }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });
});

describe("projectJwtAuth - authorizeRead", () => {
  const { authorizeRead } = projectJwtAuth();

  it("rejects with 500 when PROJECT_KEYS not configured", async () => {
    const result = await authorizeRead(makeRequest("token"), "myproject/test", {} as any, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(500);
  });

  it("rejects with 401 and authFailed when no token", async () => {
    const kv = createMockKV({ [PROJECT_ID]: { signingSecret: SECRET } });
    const result = await authorizeRead(makeRequest(), "myproject/test", { PROJECT_KEYS: kv }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect((result as any).authFailed).toBe(true);
    }
  });

  it("allows valid read JWT", async () => {
    const kv = createMockKV({ [PROJECT_ID]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ scope: "read" }), SECRET);
    const result = await authorizeRead(makeRequest(token), "myproject/test", { PROJECT_KEYS: kv }, null);
    expect(result).toHaveProperty("ok", true);
  });

  it("allows valid write JWT for reads", async () => {
    const kv = createMockKV({ [PROJECT_ID]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ scope: "write" }), SECRET);
    const result = await authorizeRead(makeRequest(token), "myproject/test", { PROJECT_KEYS: kv }, null);
    expect(result).toHaveProperty("ok", true);
  });

  it("rejects with 403 when stream_id does not match", async () => {
    const kv = createMockKV({ [PROJECT_ID]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ scope: "read", stream_id: "other-stream" }), SECRET);
    const result = await authorizeRead(makeRequest(token), "myproject/test-stream", { PROJECT_KEYS: kv }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect((result as any).authFailed).toBe(true);
    }
  });

  it("allows when stream_id matches", async () => {
    const kv = createMockKV({ [PROJECT_ID]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ scope: "read", stream_id: "test-stream" }), SECRET);
    const result = await authorizeRead(makeRequest(token), "myproject/test-stream", { PROJECT_KEYS: kv }, null);
    expect(result).toHaveProperty("ok", true);
  });

  it("sets authFailed flag on all auth failures", async () => {
    const kv = createMockKV({ [PROJECT_ID]: { signingSecret: SECRET } });
    const token = await createTestJwt(validClaims({ sub: "wrong" }), SECRET);
    const result = await authorizeRead(makeRequest(token), "myproject/test", { PROJECT_KEYS: kv }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) {
      expect((result as any).authFailed).toBe(true);
    }
  });
});
