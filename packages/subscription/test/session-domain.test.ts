import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fetchFromCore
const mockFetchFromCore = vi.fn();
vi.mock("../src/client", () => ({
  fetchFromCore: (...args: unknown[]) => mockFetchFromCore(...args),
}));

// Mock metrics
const mockMetrics = {
  sessionTouch: vi.fn(),
  sessionDelete: vi.fn(),
};
vi.mock("../src/metrics", () => ({
  createMetrics: vi.fn(() => mockMetrics),
}));

// Mock analytics
const mockGetSessionSubscriptions = vi.fn();
vi.mock("../src/analytics", () => ({
  getSessionSubscriptions: (...args: unknown[]) => mockGetSessionSubscriptions(...args),
}));

function createEnv() {
  return {
    CORE_URL: "http://localhost:8787",
    METRICS: undefined,
    ACCOUNT_ID: "test-account",
    API_TOKEN: "test-token",
    ANALYTICS_DATASET: "test_metrics",
  };
}

describe("getSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchFromCore.mockReset();
    mockGetSessionSubscriptions.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("returns null when core returns 404", async () => {
    mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 404 }));

    const { getSession } = await import("../src/session");
    const result = await getSession(createEnv() as never, "session-missing");

    expect(result).toBeNull();
  });

  it("returns session info when core responds ok", async () => {
    mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 200 }));
    mockGetSessionSubscriptions.mockResolvedValueOnce({
      data: [{ streamId: "stream-a" }, { streamId: "stream-b" }],
    });

    const { getSession } = await import("../src/session");
    const result = await getSession(createEnv() as never, "session-123");

    expect(result).toEqual({
      sessionId: "session-123",
      sessionStreamPath: "/v1/stream/session:session-123",
      subscriptions: [{ streamId: "stream-a" }, { streamId: "stream-b" }],
    });
  });

  it("analytics failure degrades gracefully — returns empty subscriptions", async () => {
    mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 200 }));
    mockGetSessionSubscriptions.mockResolvedValueOnce({
      data: [],
      error: "Analytics Engine unavailable",
    });

    const { getSession } = await import("../src/session");
    const result = await getSession(createEnv() as never, "session-123");

    expect(result).toEqual({
      sessionId: "session-123",
      sessionStreamPath: "/v1/stream/session:session-123",
      subscriptions: [],
    });
  });
});

describe("touchSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchFromCore.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("succeeds on 200", async () => {
    mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const { touchSession } = await import("../src/session");
    const result = await touchSession(createEnv() as never, "session-123");

    expect(result.sessionId).toBe("session-123");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(mockMetrics.sessionTouch).toHaveBeenCalled();
  });

  it("succeeds on 409 (already exists)", async () => {
    mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 409 }));

    const { touchSession } = await import("../src/session");
    const result = await touchSession(createEnv() as never, "session-123");

    expect(result.sessionId).toBe("session-123");
    expect(mockMetrics.sessionTouch).toHaveBeenCalled();
  });

  it("throws on 500 with correct error message", async () => {
    mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 500 }));

    const { touchSession } = await import("../src/session");
    await expect(touchSession(createEnv() as never, "session-123")).rejects.toThrow(
      "Failed to touch session: session-123 (status: 500)",
    );
  });
});

describe("deleteSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchFromCore.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("succeeds on 200", async () => {
    mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const { deleteSession } = await import("../src/session");
    const result = await deleteSession(createEnv() as never, "session-123");

    expect(result).toEqual({ sessionId: "session-123", deleted: true });
    expect(mockMetrics.sessionDelete).toHaveBeenCalled();
  });

  it("succeeds on 404 (idempotent)", async () => {
    mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 404 }));

    const { deleteSession } = await import("../src/session");
    const result = await deleteSession(createEnv() as never, "session-123");

    expect(result).toEqual({ sessionId: "session-123", deleted: true });
  });

  it("throws on 500", async () => {
    mockFetchFromCore.mockResolvedValueOnce(new Response(null, { status: 500 }));

    const { deleteSession } = await import("../src/session");
    await expect(deleteSession(createEnv() as never, "session-123")).rejects.toThrow(
      "Failed to delete session: session-123",
    );
  });
});
