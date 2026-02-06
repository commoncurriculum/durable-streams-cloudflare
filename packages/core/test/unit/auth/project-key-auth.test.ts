import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  projectKeyMutationAuth,
  projectKeyReadAuth,
  extractBearerToken,
} from "../../../src/http/auth";

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

describe("projectKeyMutationAuth", () => {
  const auth = projectKeyMutationAuth();

  it("allows all when no auth configured", async () => {
    const result = await auth(makeRequest(), "myproject/test-stream", {}, null);
    expect(result).toEqual({ ok: true });
  });

  it("rejects with 401 when no token provided but auth is configured", async () => {
    const result = await auth(makeRequest(), "myproject/test-stream", { AUTH_TOKEN: "super" }, null);
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("allows superuser AUTH_TOKEN regardless of project", async () => {
    const result = await auth(
      makeRequest("super"),
      "myproject/test-stream",
      { AUTH_TOKEN: "super" },
      null,
    );
    expect(result).toEqual({ ok: true });
  });

  it("allows valid project key with matching project", async () => {
    const kv = createMockKV({ "sk_test_123": { project: "myproject" } });
    const result = await auth(
      makeRequest("sk_test_123"),
      "myproject/test-stream",
      { PROJECT_KEYS: kv },
      null,
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects valid project key with wrong project (403)", async () => {
    const kv = createMockKV({ "sk_test_123": { project: "myproject" } });
    const result = await auth(
      makeRequest("sk_test_123"),
      "other-project/test-stream",
      { PROJECT_KEYS: kv },
      null,
    );
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("rejects unknown key with 401", async () => {
    const kv = createMockKV({});
    const result = await auth(
      makeRequest("unknown-key"),
      "myproject/test-stream",
      { PROJECT_KEYS: kv },
      null,
    );
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("AUTH_TOKEN takes precedence over project key check", async () => {
    const kv = createMockKV({});
    const result = await auth(
      makeRequest("super"),
      "any-project/test-stream",
      { AUTH_TOKEN: "super", PROJECT_KEYS: kv },
      null,
    );
    expect(result).toEqual({ ok: true });
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("rejects when streamId has no project prefix", async () => {
    const kv = createMockKV({ "sk_test_123": { project: "myproject" } });
    const result = await auth(
      makeRequest("sk_test_123"),
      "no-slash-stream",
      { PROJECT_KEYS: kv },
      null,
    );
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });
});

describe("projectKeyReadAuth", () => {
  const auth = projectKeyReadAuth();

  it("allows all when no auth configured", async () => {
    const result = await auth(makeRequest(), "myproject/test-stream", {}, null);
    expect(result).toHaveProperty("ok", true);
  });

  it("allows valid project key with matching project", async () => {
    const kv = createMockKV({ "sk_test_123": { project: "myproject" } });
    const result = await auth(
      makeRequest("sk_test_123"),
      "myproject/test-stream",
      { PROJECT_KEYS: kv },
      null,
    );
    expect(result).toHaveProperty("ok", true);
  });

  it("rejects valid project key with wrong project (403)", async () => {
    const kv = createMockKV({ "sk_test_123": { project: "myproject" } });
    const result = await auth(
      makeRequest("sk_test_123"),
      "other-project/test-stream",
      { PROJECT_KEYS: kv },
      null,
    );
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("allows superuser AUTH_TOKEN", async () => {
    const result = await auth(
      makeRequest("super"),
      "any-project/test-stream",
      { AUTH_TOKEN: "super" },
      null,
    );
    expect(result).toHaveProperty("ok", true);
  });

  it("rejects unknown key with 401", async () => {
    const kv = createMockKV({});
    const result = await auth(
      makeRequest("unknown"),
      "myproject/test-stream",
      { PROJECT_KEYS: kv },
      null,
    );
    expect(result).toHaveProperty("ok", false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });
});
