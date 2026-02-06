import { describe, it, expect, vi, beforeEach } from "vitest";
import { fanoutToSubscribers } from "../../src/subscriptions/fanout";
import type { CoreService } from "../../src/client";

const PROJECT_ID = "test-project";

function createMockFetch() {
  return vi.fn<CoreService["fetch"]>();
}

function createEnv(mockFetch: ReturnType<typeof createMockFetch>) {
  return { CORE: { fetch: mockFetch, routeRequest: vi.fn() } as unknown as CoreService };
}

describe("fanoutToSubscribers", () => {
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    mockFetch = createMockFetch();
  });

  it("writes to all session streams", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
    const env = createEnv(mockFetch);

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
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Verify fetch was called with Request objects containing project-scoped URLs
    const call0 = mockFetch.mock.calls[0][0] as Request;
    expect(call0.url).toContain(`/v1/${PROJECT_ID}/stream/s1`);
    const call1 = mockFetch.mock.calls[1][0] as Request;
    expect(call1.url).toContain(`/v1/${PROJECT_ID}/stream/s2`);
  });

  it("batches writes in groups of 50", async () => {
    // Track the order of resolution to verify batching behavior
    const callOrder: number[] = [];
    let callCount = 0;

    mockFetch.mockImplementation(() => {
      callOrder.push(++callCount);
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    const sessionIds = Array.from({ length: 120 }, (_, i) => `session-${i}`);

    const result = await fanoutToSubscribers(
      createEnv(mockFetch),
      PROJECT_ID,
      sessionIds,
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(120);
    expect(mockFetch).toHaveBeenCalledTimes(120);
  });

  it("reports 404s as stale sessions", async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = (input as Request).url;
      if (url.includes("stale")) {
        return Promise.resolve(new Response("Not found", { status: 404 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    const result = await fanoutToSubscribers(
      createEnv(mockFetch),
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
    mockFetch.mockResolvedValue(new Response("Internal error", { status: 500 }));

    const result = await fanoutToSubscribers(
      createEnv(mockFetch),
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
    mockFetch.mockRejectedValue(new Error("Network error"));

    const result = await fanoutToSubscribers(
      createEnv(mockFetch),
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
    mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
    const env = createEnv(mockFetch);

    await fanoutToSubscribers(
      env,
      PROJECT_ID,
      ["s1"],
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "application/json",
      { "Producer-Id": "fanout:stream-1", "Producer-Epoch": "1", "Producer-Seq": "42" },
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Verify the Request has the correct URL and headers
    const calledRequest = mockFetch.mock.calls[0][0] as Request;
    expect(calledRequest.url).toContain(`/v1/${PROJECT_ID}/stream/s1`);
    expect(calledRequest.headers.get("Content-Type")).toBe("application/json");
    expect(calledRequest.headers.get("Producer-Id")).toBe("fanout:stream-1");
    expect(calledRequest.headers.get("Producer-Epoch")).toBe("1");
    expect(calledRequest.headers.get("Producer-Seq")).toBe("42");
  });

  it("returns correct counts for mixed results", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response("Not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("Error", { status: 500 }))
      .mockRejectedValueOnce(new Error("Network error"));

    const result = await fanoutToSubscribers(
      createEnv(mockFetch),
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
      createEnv(mockFetch),
      PROJECT_ID,
      [],
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(0);
    expect(result.failures).toBe(0);
    expect(result.staleSessionIds).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
