import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

const PROJECT_ID = "test-project";
const SESSION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const SESSION_ID_MISSING = "00000000-0000-0000-0000-000000000000";

const mockFetch = vi.fn();
const mockRouteRequest = vi.fn();

function createEnv() {
  return {
    CORE: { fetch: mockFetch, routeRequest: mockRouteRequest },
    METRICS: undefined,
    ACCOUNT_ID: "test-account",
    API_TOKEN: "test-token",
    ANALYTICS_DATASET: "test_metrics",
  };
}

describe("getSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRouteRequest.mockReset();
    mockGetSessionSubscriptions.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("returns null when core returns 404", async () => {
    mockRouteRequest.mockResolvedValueOnce(new Response(null, { status: 404 }));

    const { getSession } = await import("../src/session");
    const result = await getSession(createEnv() as never, PROJECT_ID, SESSION_ID_MISSING);

    expect(result).toBeNull();
  });

  it("returns session info when core responds ok", async () => {
    mockRouteRequest.mockResolvedValueOnce(new Response(null, { status: 200 }));
    mockGetSessionSubscriptions.mockResolvedValueOnce({
      data: [{ streamId: "stream-a" }, { streamId: "stream-b" }],
    });

    const { getSession } = await import("../src/session");
    const result = await getSession(createEnv() as never, PROJECT_ID, SESSION_ID);

    expect(result).toEqual({
      sessionId: SESSION_ID,
      sessionStreamPath: `/v1/${PROJECT_ID}/stream/${SESSION_ID}`,
      subscriptions: [{ streamId: "stream-a" }, { streamId: "stream-b" }],
    });
  });

  it("analytics failure degrades gracefully — returns empty subscriptions", async () => {
    mockRouteRequest.mockResolvedValueOnce(new Response(null, { status: 200 }));
    mockGetSessionSubscriptions.mockResolvedValueOnce({
      data: [],
      error: "Analytics Engine unavailable",
    });

    const { getSession } = await import("../src/session");
    const result = await getSession(createEnv() as never, PROJECT_ID, SESSION_ID);

    expect(result).toEqual({
      sessionId: SESSION_ID,
      sessionStreamPath: `/v1/${PROJECT_ID}/stream/${SESSION_ID}`,
      subscriptions: [],
    });
  });
});

describe("touchSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRouteRequest.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("succeeds on 200", async () => {
    mockRouteRequest.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const { touchSession } = await import("../src/session");
    const result = await touchSession(createEnv() as never, PROJECT_ID, SESSION_ID);

    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(mockMetrics.sessionTouch).toHaveBeenCalled();
  });

  it("succeeds on 409 (already exists)", async () => {
    mockRouteRequest.mockResolvedValueOnce(new Response(null, { status: 409 }));

    const { touchSession } = await import("../src/session");
    const result = await touchSession(createEnv() as never, PROJECT_ID, SESSION_ID);

    expect(result.sessionId).toBe(SESSION_ID);
    expect(mockMetrics.sessionTouch).toHaveBeenCalled();
  });

  it("throws on 500 with correct error message", async () => {
    mockRouteRequest.mockResolvedValueOnce(new Response(null, { status: 500 }));

    const { touchSession } = await import("../src/session");
    await expect(touchSession(createEnv() as never, PROJECT_ID, SESSION_ID)).rejects.toThrow(
      `Failed to touch session: ${SESSION_ID} (status: 500)`,
    );
  });
});

describe("deleteSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRouteRequest.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("succeeds on 200", async () => {
    mockRouteRequest.mockResolvedValueOnce(new Response(null, { status: 200 }));

    const { deleteSession } = await import("../src/session");
    const result = await deleteSession(createEnv() as never, PROJECT_ID, SESSION_ID);

    expect(result).toEqual({ sessionId: SESSION_ID, deleted: true });
    expect(mockMetrics.sessionDelete).toHaveBeenCalled();
  });

  it("succeeds on 404 (idempotent)", async () => {
    mockRouteRequest.mockResolvedValueOnce(new Response(null, { status: 404 }));

    const { deleteSession } = await import("../src/session");
    const result = await deleteSession(createEnv() as never, PROJECT_ID, SESSION_ID);

    expect(result).toEqual({ sessionId: SESSION_ID, deleted: true });
  });

  it("throws on 500", async () => {
    mockRouteRequest.mockResolvedValueOnce(new Response(null, { status: 500 }));

    const { deleteSession } = await import("../src/session");
    await expect(deleteSession(createEnv() as never, PROJECT_ID, SESSION_ID)).rejects.toThrow(
      `Failed to delete session: ${SESSION_ID}`,
    );
  });
});
