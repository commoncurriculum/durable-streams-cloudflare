import { describe, expect, it, vi, beforeEach } from "vitest";
import { queryAnalytics, QUERIES } from "../src/analytics";
import type { AdminSubscriptionEnv } from "../src/types";

function makeEnv(overrides: Partial<AdminSubscriptionEnv> = {}): AdminSubscriptionEnv {
  return {
    SUBSCRIPTION: {} as Fetcher,
    CF_ACCOUNT_ID: "test-account-id",
    CF_API_TOKEN: "test-api-token",
    ADMIN_TOKEN: "test-admin-token",
    ...overrides,
  };
}

describe("queryAnalytics", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws if CF_ACCOUNT_ID is missing", async () => {
    const env = makeEnv({ CF_ACCOUNT_ID: undefined });
    await expect(queryAnalytics(env, "SELECT 1")).rejects.toThrow(
      "CF_ACCOUNT_ID and CF_API_TOKEN are required",
    );
  });

  it("throws if CF_API_TOKEN is missing", async () => {
    const env = makeEnv({ CF_API_TOKEN: undefined });
    await expect(queryAnalytics(env, "SELECT 1")).rejects.toThrow(
      "CF_ACCOUNT_ID and CF_API_TOKEN are required",
    );
  });

  it("sends correct request to Analytics Engine API", async () => {
    const env = makeEnv();
    const mockData = [{ event_type: "publish", total: 42 }];

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: mockData }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await queryAnalytics(env, "SELECT blob3 as event_type, count() as total FROM test");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain("test-account-id");
    expect(url).toContain("/analytics_engine/sql");
    expect(options?.method).toBe("POST");
    expect(options?.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer test-api-token",
      }),
    );
    expect(options?.body).toContain("SELECT blob3");

    expect(result).toEqual(mockData);
  });

  it("throws on non-200 response", async () => {
    const env = makeEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("query error", { status: 400 }),
    );

    await expect(queryAnalytics(env, "BAD SQL")).rejects.toThrow(
      "Analytics Engine query failed (400)",
    );
  });

  it("returns empty array when data is null", async () => {
    const env = makeEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await queryAnalytics(env, "SELECT 1");
    expect(result).toEqual([]);
  });
});

describe("QUERIES", () => {
  it("systemStats queries subscriptions_metrics with GROUP BY", () => {
    expect(QUERIES.systemStats).toContain("SELECT");
    expect(QUERIES.systemStats).toContain("subscriptions_metrics");
    expect(QUERIES.systemStats).toContain("GROUP BY");
    expect(QUERIES.systemStats).toContain("blob3");
  });

  it("activeSessions filters by session category", () => {
    expect(QUERIES.activeSessions).toContain("index1 = 'session'");
    expect(QUERIES.activeSessions).toContain("session_create");
    expect(QUERIES.activeSessions).toContain("session_touch");
    expect(QUERIES.activeSessions).toContain("24");
  });

  it("activeStreams filters last 24 hours", () => {
    expect(QUERIES.activeStreams).toContain("24");
    expect(QUERIES.activeStreams).toContain("HOUR");
    expect(QUERIES.activeStreams).toContain("blob1 != ''");
  });

  it("hotStreams accepts a limit parameter", () => {
    const sql = QUERIES.hotStreams(10);
    expect(sql).toContain("LIMIT 10");
    expect(sql).toContain("index1 = 'publish'");
  });

  it("timeseries accepts window parameter", () => {
    const sql = QUERIES.timeseries(30);
    expect(sql).toContain("INTERVAL '30' MINUTE");
    expect(sql).toContain("GROUP BY bucket");
  });

  it("fanoutStats queries fanout category", () => {
    expect(QUERIES.fanoutStats).toContain("index1 = 'fanout'");
    expect(QUERIES.fanoutStats).toContain("avg_latency_ms");
  });

  it("cleanupStats queries cleanup category", () => {
    expect(QUERIES.cleanupStats).toContain("index1 = 'cleanup'");
    expect(QUERIES.cleanupStats).toContain("expired_sessions");
  });

  it("streamSubscribers injects validated streamId", () => {
    const sql = QUERIES.streamSubscribers("my-stream.v1");
    expect(sql).toContain("blob1 = 'my-stream.v1'");
    expect(sql).toContain("HAVING net > 0");
  });

  it("streamSubscribers rejects invalid stream IDs", () => {
    expect(() => QUERIES.streamSubscribers("'; DROP TABLE --")).toThrow("Invalid stream ID");
    expect(() => QUERIES.streamSubscribers("has spaces")).toThrow("Invalid stream ID");
    expect(() => QUERIES.streamSubscribers("semi;colon")).toThrow("Invalid stream ID");
  });

  it("publishErrors queries publish_error category", () => {
    expect(QUERIES.publishErrors).toContain("index1 = 'publish_error'");
    expect(QUERIES.publishErrors).toContain("error_type");
  });
});
