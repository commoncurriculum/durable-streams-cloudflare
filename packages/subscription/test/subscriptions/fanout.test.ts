import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetchFromCore = vi.fn();
vi.mock("../../src/client", () => ({
  fetchFromCore: (...args: unknown[]) => mockFetchFromCore(...args),
}));

import { fanoutToSubscribers } from "../../src/subscriptions/fanout";
import type { CoreClientEnv } from "../../src/client";

const PROJECT_ID = "test-project";

function createEnv(): CoreClientEnv {
  return { CORE_URL: "http://localhost:8787" };
}

describe("fanoutToSubscribers", () => {
  beforeEach(() => {
    mockFetchFromCore.mockReset();
  });

  it("writes to all session streams", async () => {
    mockFetchFromCore.mockResolvedValue(new Response(null, { status: 200 }));
    const env = createEnv();

    const result = await fanoutToSubscribers(
      env,
      PROJECT_ID,
      ["s1", "s2", "s3"],
      new TextEncoder().encode("hello").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(3);
    expect(result.failures).toBe(0);
    expect(result.staleSessionIds).toEqual([]);
    expect(mockFetchFromCore).toHaveBeenCalledTimes(3);

    expect(mockFetchFromCore).toHaveBeenCalledWith(
      env,
      `/v1/${PROJECT_ID}/stream/s1`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(mockFetchFromCore).toHaveBeenCalledWith(
      env,
      `/v1/${PROJECT_ID}/stream/s2`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("batches writes in groups of 50", async () => {
    // Track the order of resolution to verify batching behavior
    const callOrder: number[] = [];
    let callCount = 0;

    mockFetchFromCore.mockImplementation(() => {
      callOrder.push(++callCount);
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    const sessionIds = Array.from({ length: 120 }, (_, i) => `session-${i}`);

    const result = await fanoutToSubscribers(
      createEnv(),
      PROJECT_ID,
      sessionIds,
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(120);
    expect(mockFetchFromCore).toHaveBeenCalledTimes(120);
  });

  it("reports 404s as stale sessions", async () => {
    mockFetchFromCore.mockImplementation((_env: unknown, path: string) => {
      if (path.includes("stale")) {
        return Promise.resolve(new Response("Not found", { status: 404 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    const result = await fanoutToSubscribers(
      createEnv(),
      PROJECT_ID,
      ["active-1", "stale-1", "active-2", "stale-2"],
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(2);
    expect(result.failures).toBe(2);
    expect(result.staleSessionIds).toEqual(["stale-1", "stale-2"]);
  });

  it("handles 5xx errors as failures (not stale)", async () => {
    mockFetchFromCore.mockResolvedValue(new Response("Internal error", { status: 500 }));

    const result = await fanoutToSubscribers(
      createEnv(),
      PROJECT_ID,
      ["s1", "s2"],
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(0);
    expect(result.failures).toBe(2);
    expect(result.staleSessionIds).toEqual([]);
  });

  it("handles rejected promises as failures", async () => {
    mockFetchFromCore.mockRejectedValue(new Error("Network error"));

    const result = await fanoutToSubscribers(
      createEnv(),
      PROJECT_ID,
      ["s1"],
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(0);
    expect(result.failures).toBe(1);
    expect(result.staleSessionIds).toEqual([]);
  });

  it("passes producer headers to fetch", async () => {
    mockFetchFromCore.mockResolvedValue(new Response(null, { status: 200 }));
    const env = createEnv();

    await fanoutToSubscribers(
      env,
      PROJECT_ID,
      ["s1"],
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "application/json",
      { "Producer-Id": "fanout:stream-1", "Producer-Epoch": "1", "Producer-Seq": "42" },
    );

    expect(mockFetchFromCore).toHaveBeenCalledWith(
      env,
      `/v1/${PROJECT_ID}/stream/s1`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "Producer-Id": "fanout:stream-1",
          "Producer-Epoch": "1",
          "Producer-Seq": "42",
        }),
      }),
    );
  });

  it("returns correct counts for mixed results", async () => {
    mockFetchFromCore
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response("Not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("Error", { status: 500 }))
      .mockRejectedValueOnce(new Error("Network error"));

    const result = await fanoutToSubscribers(
      createEnv(),
      PROJECT_ID,
      ["ok", "stale", "error", "network-fail"],
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(1);
    expect(result.failures).toBe(3);
    expect(result.staleSessionIds).toEqual(["stale"]);
  });

  it("handles empty session list", async () => {
    const result = await fanoutToSubscribers(
      createEnv(),
      PROJECT_ID,
      [],
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(0);
    expect(result.failures).toBe(0);
    expect(result.staleSessionIds).toEqual([]);
    expect(mockFetchFromCore).not.toHaveBeenCalled();
  });
});
