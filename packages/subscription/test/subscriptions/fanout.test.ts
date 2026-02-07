import { describe, it, expect, vi, beforeEach } from "vitest";
import { fanoutToSubscribers } from "../../src/subscriptions/fanout";
import type { CoreService, PostStreamResult } from "../../src/client";

const PROJECT_ID = "test-project";

function createMockPostStream() {
  return vi.fn<CoreService["postStream"]>();
}

function createEnv(mockPostStream: ReturnType<typeof createMockPostStream>) {
  return { CORE: { postStream: mockPostStream, headStream: vi.fn(), putStream: vi.fn(), deleteStream: vi.fn() } as unknown as CoreService };
}

describe("fanoutToSubscribers", () => {
  let mockPostStream: ReturnType<typeof createMockPostStream>;

  beforeEach(() => {
    mockPostStream = createMockPostStream();
  });

  it("writes to all session streams", async () => {
    mockPostStream.mockResolvedValue({ ok: true, status: 200, nextOffset: null, upToDate: null, streamClosed: null, body: null });
    const env = createEnv(mockPostStream);

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
    expect(mockPostStream).toHaveBeenCalledTimes(3);

    // Verify postStream was called with correct doKeys
    expect(mockPostStream).toHaveBeenCalledWith(`${PROJECT_ID}/s1`, expect.any(ArrayBuffer), "text/plain", undefined);
    expect(mockPostStream).toHaveBeenCalledWith(`${PROJECT_ID}/s2`, expect.any(ArrayBuffer), "text/plain", undefined);
    expect(mockPostStream).toHaveBeenCalledWith(`${PROJECT_ID}/s3`, expect.any(ArrayBuffer), "text/plain", undefined);
  });

  it("batches writes in groups of 50", async () => {
    // Track the order of resolution to verify batching behavior
    const callOrder: number[] = [];
    let callCount = 0;

    mockPostStream.mockImplementation(() => {
      callOrder.push(++callCount);
      return Promise.resolve({ ok: true, status: 200, nextOffset: null, upToDate: null, streamClosed: null, body: null } as PostStreamResult);
    });

    const sessionIds = Array.from({ length: 120 }, (_, i) => `session-${i}`);

    const result = await fanoutToSubscribers(
      createEnv(mockPostStream),
      PROJECT_ID,
      sessionIds,
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(120);
    expect(mockPostStream).toHaveBeenCalledTimes(120);
  });

  it("reports 404s as stale sessions", async () => {
    mockPostStream.mockImplementation((doKey: string) => {
      if (doKey.includes("stale")) {
        return Promise.resolve({ ok: false, status: 404, nextOffset: null, upToDate: null, streamClosed: null, body: "Not found" });
      }
      return Promise.resolve({ ok: true, status: 200, nextOffset: null, upToDate: null, streamClosed: null, body: null });
    });

    const result = await fanoutToSubscribers(
      createEnv(mockPostStream),
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
    mockPostStream.mockResolvedValue({ ok: false, status: 500, nextOffset: null, upToDate: null, streamClosed: null, body: "Internal error" });

    const result = await fanoutToSubscribers(
      createEnv(mockPostStream),
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
    mockPostStream.mockRejectedValue(new Error("Network error"));

    const result = await fanoutToSubscribers(
      createEnv(mockPostStream),
      PROJECT_ID,
      ["s1"],
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(0);
    expect(result.failures).toBe(1);
    expect(result.staleSessionIds).toEqual([]);
  });

  it("passes producer headers to postStream", async () => {
    mockPostStream.mockResolvedValue({ ok: true, status: 200, nextOffset: null, upToDate: null, streamClosed: null, body: null });
    const env = createEnv(mockPostStream);

    await fanoutToSubscribers(
      env,
      PROJECT_ID,
      ["s1"],
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "application/json",
      { producerId: "fanout:stream-1", producerEpoch: "1", producerSeq: "42" },
    );

    expect(mockPostStream).toHaveBeenCalledTimes(1);
    expect(mockPostStream).toHaveBeenCalledWith(
      `${PROJECT_ID}/s1`,
      expect.any(ArrayBuffer),
      "application/json",
      { producerId: "fanout:stream-1", producerEpoch: "1", producerSeq: "42" },
    );
  });

  it("returns correct counts for mixed results", async () => {
    mockPostStream
      .mockResolvedValueOnce({ ok: true, status: 200, nextOffset: null, upToDate: null, streamClosed: null, body: null })
      .mockResolvedValueOnce({ ok: false, status: 404, nextOffset: null, upToDate: null, streamClosed: null, body: "Not found" })
      .mockResolvedValueOnce({ ok: false, status: 500, nextOffset: null, upToDate: null, streamClosed: null, body: "Error" })
      .mockRejectedValueOnce(new Error("Network error"));

    const result = await fanoutToSubscribers(
      createEnv(mockPostStream),
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
      createEnv(mockPostStream),
      PROJECT_ID,
      [],
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(0);
    expect(result.failures).toBe(0);
    expect(result.staleSessionIds).toEqual([]);
    expect(mockPostStream).not.toHaveBeenCalled();
  });
});
