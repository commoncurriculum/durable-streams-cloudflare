import { describe, expect, it, vi, beforeEach } from "vitest";
import { queryAnalytics, QUERIES } from "../src/analytics";
import type { AdminEnv } from "../src/types";

function makeEnv(overrides: Partial<AdminEnv> = {}): AdminEnv {
  return {
    CORE: {} as Fetcher,
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
    const mockData = [{ event_type: "append", total: 42 }];

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: mockData }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await queryAnalytics(env, "SELECT blob2 as event_type, count() as total FROM test");

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
    expect(options?.body).toContain("SELECT blob2");

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
  it("systemStats is a valid SQL string", () => {
    expect(QUERIES.systemStats).toContain("SELECT");
    expect(QUERIES.systemStats).toContain("durable_streams_metrics");
    expect(QUERIES.systemStats).toContain("GROUP BY");
  });

  it("streamList queries last 24 hours", () => {
    expect(QUERIES.streamList).toContain("24");
    expect(QUERIES.streamList).toContain("HOUR");
    expect(QUERIES.streamList).toContain("ORDER BY");
  });

  it("hotStreams accepts a limit parameter", () => {
    const sql = QUERIES.hotStreams(10);
    expect(sql).toContain("LIMIT 10");
    expect(sql).toContain("append");
  });

  it("timeseries accepts window parameter", () => {
    const sql = QUERIES.timeseries(30);
    expect(sql).toContain("INTERVAL '30' MINUTE");
  });
});
