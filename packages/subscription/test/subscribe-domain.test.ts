import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AppEnv } from "../src/env";

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

const mockPutStream = vi.fn();
const mockDeleteStream = vi.fn();

function createEnv() {
  return {
    SUBSCRIPTION_DO: {
      get: vi.fn().mockReturnValue(mockStub),
      idFromName: mockIdFromName,
    } as unknown as AppEnv["SUBSCRIPTION_DO"],
    CORE: { putStream: mockPutStream, deleteStream: mockDeleteStream, headStream: vi.fn(), postStream: vi.fn() },
    METRICS: undefined,
  };
}

describe("subscribe domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPutStream.mockReset();
    mockDeleteStream.mockReset();
    mockAddSubscriber.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("happy path — session created, DO succeeds, metrics recorded", async () => {
    mockPutStream.mockResolvedValueOnce({ ok: true, status: 200 });
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
    mockPutStream.mockResolvedValueOnce({ ok: false, status: 409 });
    mockAddSubscriber.mockResolvedValueOnce(undefined);

    const { subscribe } = await import("../src/subscriptions/subscribe");
    const result = await subscribe(createEnv() as never, PROJECT_ID, "stream-1", SESSION_ID);

    expect(result.isNewSession).toBe(false);
    expect(mockMetrics.subscribe).toHaveBeenCalledWith("stream-1", SESSION_ID, false, expect.any(Number));
    expect(mockMetrics.sessionCreate).not.toHaveBeenCalled();
  });

  it("DO failure triggers rollback for new session", async () => {
    // Core creates session (200)
    mockPutStream.mockResolvedValueOnce({ ok: true, status: 200 });
    // DO fails
    mockAddSubscriber.mockRejectedValueOnce(new Error("DO error"));
    // Rollback DELETE
    mockDeleteStream.mockResolvedValueOnce({ ok: true, status: 200 });

    const { subscribe } = await import("../src/subscriptions/subscribe");
    await expect(subscribe(createEnv() as never, PROJECT_ID, "stream-1", SESSION_ID)).rejects.toThrow("DO error");

    // Verify deleteStream RPC was called to rollback with correct doKey
    expect(mockDeleteStream).toHaveBeenCalledWith(`${PROJECT_ID}/${SESSION_ID}`);
  });

  it("DO failure does NOT rollback existing session (409)", async () => {
    // Core returns 409 (session exists)
    mockPutStream.mockResolvedValueOnce({ ok: false, status: 409 });
    // DO fails
    mockAddSubscriber.mockRejectedValueOnce(new Error("DO error"));

    const { subscribe } = await import("../src/subscriptions/subscribe");
    await expect(subscribe(createEnv() as never, PROJECT_ID, "stream-1", SESSION_ID)).rejects.toThrow("DO error");

    // No rollback DELETE
    expect(mockDeleteStream).not.toHaveBeenCalled();
  });

  it("rollback itself fails — original error still thrown", async () => {
    // Core creates session (200)
    mockPutStream.mockResolvedValueOnce({ ok: true, status: 200 });
    // DO fails
    mockAddSubscriber.mockRejectedValueOnce(new Error("DO error"));
    // Rollback DELETE fails
    mockDeleteStream.mockRejectedValueOnce(new Error("rollback failed"));

    const { subscribe } = await import("../src/subscriptions/subscribe");
    await expect(subscribe(createEnv() as never, PROJECT_ID, "stream-1", SESSION_ID)).rejects.toThrow("DO error");
  });
});
