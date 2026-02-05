import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock fanout
vi.mock("../../src/fanout", () => ({
  fanOutToSubscribers: vi.fn(),
}));

// Mock metrics
vi.mock("../../src/metrics", () => ({
  createMetrics: vi.fn(() => ({
    publish: vi.fn(),
    publishError: vi.fn(),
  })),
}));

// Mock core-client
vi.mock("../../src/core-client", () => ({
  fetchFromCore: vi.fn(),
}));

function createTestApp() {
  return import("../../src/routes/publish").then(({ publishRoutes }) => {
    const app = new Hono();
    app.route("/v1", publishRoutes);
    return app;
  });
}

function createMockEnv() {
  return {
    DB: {} as D1Database,
    CORE_URL: "http://localhost:8787",
    METRICS: {} as AnalyticsEngineDataset,
  };
}

function createMockCoreResponse(options: {
  status?: number;
  ok?: boolean;
  body?: string;
  headers?: Record<string, string>;
} = {}) {
  const {
    status = 200,
    ok = true,
    body = "{}",
    headers = {},
  } = options;

  return {
    ok,
    status,
    headers: new Headers(headers),
    text: vi.fn().mockResolvedValue(body),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  } as unknown as Response;
}

describe("POST /publish/:streamId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("core write", () => {
    it("calls fetchFromCore with correct path /v1/stream/:streamId", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { fanOutToSubscribers } = await import("../../src/fanout");

      vi.mocked(fetchFromCore).mockResolvedValue(createMockCoreResponse());
      vi.mocked(fanOutToSubscribers).mockResolvedValue({
        fanoutCount: 0,
        successCount: 0,
        failureCount: 0,
      });

      const app = await createTestApp();
      await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: JSON.stringify({ data: "test" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(fetchFromCore).toHaveBeenCalledWith(
        expect.anything(),
        "/v1/stream/my-stream",
        expect.any(Object),
      );
    });

    it("passes request body to core", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { fanOutToSubscribers } = await import("../../src/fanout");

      vi.mocked(fetchFromCore).mockResolvedValue(createMockCoreResponse());
      vi.mocked(fanOutToSubscribers).mockResolvedValue({
        fanoutCount: 0,
        successCount: 0,
        failureCount: 0,
      });

      const app = await createTestApp();
      await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(fetchFromCore).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({
          method: "POST",
          body: expect.any(ArrayBuffer),
        }),
      );
    });

    it("passes Content-Type header to core", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { fanOutToSubscribers } = await import("../../src/fanout");

      vi.mocked(fetchFromCore).mockResolvedValue(createMockCoreResponse());
      vi.mocked(fanOutToSubscribers).mockResolvedValue({
        fanoutCount: 0,
        successCount: 0,
        failureCount: 0,
      });

      const app = await createTestApp();
      await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "plain text",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(fetchFromCore).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "text/plain",
          }),
        }),
      );
    });
  });

  describe("producer headers (idempotency)", () => {
    it("passes Producer-Id header when present", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { fanOutToSubscribers } = await import("../../src/fanout");

      vi.mocked(fetchFromCore).mockResolvedValue(createMockCoreResponse());
      vi.mocked(fanOutToSubscribers).mockResolvedValue({
        fanoutCount: 0,
        successCount: 0,
        failureCount: 0,
      });

      const app = await createTestApp();
      await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": "producer-1",
          "Producer-Epoch": "1",
          "Producer-Seq": "42",
        },
      }, createMockEnv());

      expect(fetchFromCore).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Producer-Id": "producer-1",
          }),
        }),
      );
    });

    it("passes Producer-Epoch header when present", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { fanOutToSubscribers } = await import("../../src/fanout");

      vi.mocked(fetchFromCore).mockResolvedValue(createMockCoreResponse());
      vi.mocked(fanOutToSubscribers).mockResolvedValue({
        fanoutCount: 0,
        successCount: 0,
        failureCount: 0,
      });

      const app = await createTestApp();
      await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": "producer-1",
          "Producer-Epoch": "5",
          "Producer-Seq": "42",
        },
      }, createMockEnv());

      expect(fetchFromCore).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Producer-Epoch": "5",
          }),
        }),
      );
    });

    it("passes Producer-Seq header when present", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { fanOutToSubscribers } = await import("../../src/fanout");

      vi.mocked(fetchFromCore).mockResolvedValue(createMockCoreResponse());
      vi.mocked(fanOutToSubscribers).mockResolvedValue({
        fanoutCount: 0,
        successCount: 0,
        failureCount: 0,
      });

      const app = await createTestApp();
      await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": "producer-1",
          "Producer-Epoch": "1",
          "Producer-Seq": "123",
        },
      }, createMockEnv());

      expect(fetchFromCore).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "Producer-Seq": "123",
          }),
        }),
      );
    });

    it("omits producer headers when any are missing", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { fanOutToSubscribers } = await import("../../src/fanout");

      vi.mocked(fetchFromCore).mockResolvedValue(createMockCoreResponse());
      vi.mocked(fanOutToSubscribers).mockResolvedValue({
        fanoutCount: 0,
        successCount: 0,
        failureCount: 0,
      });

      const app = await createTestApp();

      // Only providing Producer-Id, missing Epoch and Seq
      await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": "producer-1",
        },
      }, createMockEnv());

      const callArgs = vi.mocked(fetchFromCore).mock.calls[0];
      const headers = callArgs[2]?.headers as Record<string, string>;

      expect(headers["Producer-Id"]).toBeUndefined();
      expect(headers["Producer-Epoch"]).toBeUndefined();
      expect(headers["Producer-Seq"]).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("returns error response when core write fails", async () => {
      const { fetchFromCore } = await import("../../src/core-client");

      vi.mocked(fetchFromCore).mockResolvedValue(
        createMockCoreResponse({ ok: false, status: 500, body: "Internal error" }),
      );

      const app = await createTestApp();
      const res = await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Failed to write to stream");
    });

    it("records publishError metric with status code on failure", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { createMetrics } = await import("../../src/metrics");

      const mockMetrics = {
        publish: vi.fn(),
        publishError: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

      vi.mocked(fetchFromCore).mockResolvedValue(
        createMockCoreResponse({ ok: false, status: 503, body: "Service unavailable" }),
      );

      const app = await createTestApp();
      await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(mockMetrics.publishError).toHaveBeenCalledWith(
        "my-stream",
        "http_503",
        expect.any(Number),
      );
    });

    it("returns 400 for 400 core response", async () => {
      const { fetchFromCore } = await import("../../src/core-client");

      vi.mocked(fetchFromCore).mockResolvedValue(
        createMockCoreResponse({ ok: false, status: 400, body: "Bad request" }),
      );

      const app = await createTestApp();
      const res = await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(res.status).toBe(400);
    });

    it("returns 404 for 404 core response", async () => {
      const { fetchFromCore } = await import("../../src/core-client");

      vi.mocked(fetchFromCore).mockResolvedValue(
        createMockCoreResponse({ ok: false, status: 404, body: "Not found" }),
      );

      const app = await createTestApp();
      const res = await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(res.status).toBe(404);
    });

    it("returns 500 for 500 core response", async () => {
      const { fetchFromCore } = await import("../../src/core-client");

      vi.mocked(fetchFromCore).mockResolvedValue(
        createMockCoreResponse({ ok: false, status: 500, body: "Server error" }),
      );

      const app = await createTestApp();
      const res = await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(res.status).toBe(500);
    });
  });

  describe("fanout", () => {
    it("fans out to subscribers after successful core write", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { fanOutToSubscribers } = await import("../../src/fanout");

      vi.mocked(fetchFromCore).mockResolvedValue(createMockCoreResponse());
      vi.mocked(fanOutToSubscribers).mockResolvedValue({
        fanoutCount: 5,
        successCount: 5,
        failureCount: 0,
      });

      const app = await createTestApp();
      await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(fanOutToSubscribers).toHaveBeenCalledWith(
        expect.anything(),
        "my-stream",
        expect.any(ArrayBuffer),
        "text/plain",
        undefined, // No producer headers when X-Stream-Next-Offset is not present
      );
    });

    it("uses X-Stream-Next-Offset from core for fanout deduplication", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { fanOutToSubscribers } = await import("../../src/fanout");

      vi.mocked(fetchFromCore).mockResolvedValue(
        createMockCoreResponse({
          headers: { "X-Stream-Next-Offset": "100" },
        }),
      );
      vi.mocked(fanOutToSubscribers).mockResolvedValue({
        fanoutCount: 1,
        successCount: 1,
        failureCount: 0,
      });

      const app = await createTestApp();
      await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(fanOutToSubscribers).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.any(ArrayBuffer),
        expect.any(String),
        expect.objectContaining({
          "Producer-Seq": "100",
        }),
      );
    });

    it("creates fanout producer headers with fanout:streamId prefix", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { fanOutToSubscribers } = await import("../../src/fanout");

      vi.mocked(fetchFromCore).mockResolvedValue(
        createMockCoreResponse({
          headers: { "X-Stream-Next-Offset": "42" },
        }),
      );
      vi.mocked(fanOutToSubscribers).mockResolvedValue({
        fanoutCount: 1,
        successCount: 1,
        failureCount: 0,
      });

      const app = await createTestApp();
      await app.request("/v1/publish/my-stream-id", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(fanOutToSubscribers).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.any(ArrayBuffer),
        expect.any(String),
        expect.objectContaining({
          "Producer-Id": "fanout:my-stream-id",
          "Producer-Epoch": "1",
        }),
      );
    });
  });

  describe("response", () => {
    it("returns core response body on success", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { fanOutToSubscribers } = await import("../../src/fanout");

      vi.mocked(fetchFromCore).mockResolvedValue(
        createMockCoreResponse({ body: '{"offset": 42}' }),
      );
      vi.mocked(fanOutToSubscribers).mockResolvedValue({
        fanoutCount: 0,
        successCount: 0,
        failureCount: 0,
      });

      const app = await createTestApp();
      const res = await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(res.status).toBe(200);
    });

    it("includes X-Fanout-Count header", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { fanOutToSubscribers } = await import("../../src/fanout");

      vi.mocked(fetchFromCore).mockResolvedValue(createMockCoreResponse());
      vi.mocked(fanOutToSubscribers).mockResolvedValue({
        fanoutCount: 10,
        successCount: 8,
        failureCount: 2,
      });

      const app = await createTestApp();
      const res = await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(res.headers.get("X-Fanout-Count")).toBe("10");
    });

    it("includes X-Fanout-Successes header", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { fanOutToSubscribers } = await import("../../src/fanout");

      vi.mocked(fetchFromCore).mockResolvedValue(createMockCoreResponse());
      vi.mocked(fanOutToSubscribers).mockResolvedValue({
        fanoutCount: 10,
        successCount: 8,
        failureCount: 2,
      });

      const app = await createTestApp();
      const res = await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(res.headers.get("X-Fanout-Successes")).toBe("8");
    });

    it("includes X-Fanout-Failures header", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { fanOutToSubscribers } = await import("../../src/fanout");

      vi.mocked(fetchFromCore).mockResolvedValue(createMockCoreResponse());
      vi.mocked(fanOutToSubscribers).mockResolvedValue({
        fanoutCount: 10,
        successCount: 8,
        failureCount: 2,
      });

      const app = await createTestApp();
      const res = await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(res.headers.get("X-Fanout-Failures")).toBe("2");
    });

    it("preserves core response headers", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { fanOutToSubscribers } = await import("../../src/fanout");

      vi.mocked(fetchFromCore).mockResolvedValue(
        createMockCoreResponse({
          headers: {
            "X-Stream-Next-Offset": "999",
            "X-Custom-Header": "custom-value",
          },
        }),
      );
      vi.mocked(fanOutToSubscribers).mockResolvedValue({
        fanoutCount: 0,
        successCount: 0,
        failureCount: 0,
      });

      const app = await createTestApp();
      const res = await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(res.headers.get("X-Stream-Next-Offset")).toBe("999");
      expect(res.headers.get("X-Custom-Header")).toBe("custom-value");
    });
  });

  describe("metrics", () => {
    it("records publish metric on success with fanoutCount and latency", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { fanOutToSubscribers } = await import("../../src/fanout");
      const { createMetrics } = await import("../../src/metrics");

      const mockMetrics = {
        publish: vi.fn(),
        publishError: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

      vi.mocked(fetchFromCore).mockResolvedValue(createMockCoreResponse());
      vi.mocked(fanOutToSubscribers).mockResolvedValue({
        fanoutCount: 15,
        successCount: 15,
        failureCount: 0,
      });

      const app = await createTestApp();
      await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(mockMetrics.publish).toHaveBeenCalledWith(
        "my-stream",
        15, // fanoutCount
        expect.any(Number), // latency
      );
    });

    it("records latency from request start to response", async () => {
      const { fetchFromCore } = await import("../../src/core-client");
      const { fanOutToSubscribers } = await import("../../src/fanout");
      const { createMetrics } = await import("../../src/metrics");

      const mockMetrics = {
        publish: vi.fn(),
        publishError: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

      vi.mocked(fetchFromCore).mockResolvedValue(createMockCoreResponse());
      vi.mocked(fanOutToSubscribers).mockResolvedValue({
        fanoutCount: 0,
        successCount: 0,
        failureCount: 0,
      });

      const app = await createTestApp();
      await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      const latency = mockMetrics.publish.mock.calls[0][2];
      expect(typeof latency).toBe("number");
      expect(latency).toBeGreaterThanOrEqual(0);
    });
  });
});
