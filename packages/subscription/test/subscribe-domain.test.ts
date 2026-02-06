import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AppEnv } from "../src/env";

// Mock fetchFromCore
const mockFetchFromCore = vi.fn();
vi.mock("../src/client", () => ({
  fetchFromCore: (...args: unknown[]) => mockFetchFromCore(...args),
}));

// Mock metrics
const mockMetrics = {
  subscribe: vi.fn(),
  sessionCreate: vi.fn(),
};
vi.mock("../src/metrics", () => ({
  createMetrics: vi.fn(() => mockMetrics),
}));

// Mock DO stub
const mockAddSubscriber = vi.fn();
const mockStub = { addSubscriber: mockAddSubscriber };
const mockIdFromName = vi.fn().mockReturnValue("do-id");

const PROJECT_ID = "test-project";
const SESSION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function createEnv() {
  return {
    SUBSCRIPTION_DO: {
      get: vi.fn().mockReturnValue(mockStub),
      idFromName: mockIdFromName,
    } as unknown as AppEnv["SUBSCRIPTION_DO"],
    CORE_URL: "http://localhost:8787",
    METRICS: undefined,
  };
}

describe("subscribe domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchFromCore.mockReset();
    mockAddSubscriber.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("happy path — session created, DO succeeds, metrics recorded", async () => {
    mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 200 }));
    mockAddSubscriber.mockResolvedValueOnce(undefined);

    const { subscribe } = await import("../src/subscriptions/subscribe");
    const env = createEnv();
    const result = await subscribe(env as never, PROJECT_ID, "stream-1", SESSION_ID, "application/json");

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.streamId).toBe("stream-1");
    expect(result.sessionStreamPath).toBe(`/v1/${PROJECT_ID}/stream/${SESSION_ID}`);
    expect(mockMetrics.subscribe).toHaveBeenCalledWith("stream-1", SESSION_ID, true, expect.any(Number));
    expect(mockMetrics.sessionCreate).toHaveBeenCalled();
  });

  it("session already exists (409) — isNewSession is false", async () => {
    mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 409 }));
    mockAddSubscriber.mockResolvedValueOnce(undefined);

    const { subscribe } = await import("../src/subscriptions/subscribe");
    const result = await subscribe(createEnv() as never, PROJECT_ID, "stream-1", SESSION_ID);

    expect(result.isNewSession).toBe(false);
    expect(mockMetrics.subscribe).toHaveBeenCalledWith("stream-1", SESSION_ID, false, expect.any(Number));
    expect(mockMetrics.sessionCreate).not.toHaveBeenCalled();
  });

  it("DO failure triggers rollback for new session", async () => {
    // Core creates session (200)
    mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 200 }));
    // DO fails
    mockAddSubscriber.mockRejectedValueOnce(new Error("DO error"));
    // Rollback DELETE
    mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const { subscribe } = await import("../src/subscriptions/subscribe");
    await expect(subscribe(createEnv() as never, PROJECT_ID, "stream-1", SESSION_ID)).rejects.toThrow("DO error");

    // Verify DELETE was called to rollback
    expect(mockFetchFromCore).toHaveBeenCalledTimes(2);
    expect(mockFetchFromCore).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      `/v1/${PROJECT_ID}/stream/${SESSION_ID}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("DO failure does NOT rollback existing session (409)", async () => {
    // Core returns 409 (session exists)
    mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 409 }));
    // DO fails
    mockAddSubscriber.mockRejectedValueOnce(new Error("DO error"));

    const { subscribe } = await import("../src/subscriptions/subscribe");
    await expect(subscribe(createEnv() as never, PROJECT_ID, "stream-1", SESSION_ID)).rejects.toThrow("DO error");

    // No rollback DELETE
    expect(mockFetchFromCore).toHaveBeenCalledTimes(1);
  });

  it("rollback itself fails — original error still thrown", async () => {
    // Core creates session (200)
    mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 200 }));
    // DO fails
    mockAddSubscriber.mockRejectedValueOnce(new Error("DO error"));
    // Rollback DELETE fails
    mockFetchFromCore.mockRejectedValueOnce(new Error("rollback failed"));

    const { subscribe } = await import("../src/subscriptions/subscribe");
    await expect(subscribe(createEnv() as never, PROJECT_ID, "stream-1", SESSION_ID)).rejects.toThrow("DO error");
  });
});
