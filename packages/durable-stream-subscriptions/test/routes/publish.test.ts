import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock metrics
vi.mock("../../src/metrics", () => ({
  createMetrics: vi.fn(() => ({
    publish: vi.fn(),
    publishError: vi.fn(),
  })),
}));

function createTestApp() {
  return import("../../src/routes/publish").then(({ publishRoutes }) => {
    const app = new Hono();
    app.route("/v1", publishRoutes);
    return app;
  });
}

function createMockDoResponse(options: {
  ok?: boolean;
  status?: number;
  body?: string;
  headers?: Record<string, string>;
} = {}) {
  const {
    ok = true,
    status = 200,
    body = "{}",
    headers = {},
  } = options;

  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function createMockDoFetch(response: Response) {
  return vi.fn().mockResolvedValue(response);
}

function createMockDoNamespace(mockDoFetch: ReturnType<typeof vi.fn>) {
  return {
    idFromName: vi.fn().mockReturnValue("do-id"),
    get: vi.fn().mockReturnValue({ fetch: mockDoFetch }),
  };
}

function createMockEnv(mockDoNamespace: ReturnType<typeof createMockDoNamespace>) {
  return {
    CORE_URL: "http://localhost:8787",
    SUBSCRIPTION_DO: mockDoNamespace as unknown as DurableObjectNamespace,
    METRICS: {} as AnalyticsEngineDataset,
  };
}

describe("POST /publish/:streamId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("routing to SubscriptionDO", () => {
    it("routes to SubscriptionDO for the correct streamId", async () => {
      const mockResponse = createMockDoResponse();
      const mockDoFetch = createMockDoFetch(mockResponse);
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      const app = await createTestApp();
      await app.request("/v1/publish/my-stream-id", {
        method: "POST",
        body: JSON.stringify({ data: "test" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv(mockDoNamespace));

      // Verify DO was addressed by streamId
      expect(mockDoNamespace.idFromName).toHaveBeenCalledWith("my-stream-id");
      expect(mockDoNamespace.get).toHaveBeenCalled();
    });

    it("calls DO publish endpoint", async () => {
      const mockResponse = createMockDoResponse();
      const mockDoFetch = createMockDoFetch(mockResponse);
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      const app = await createTestApp();
      await app.request("/v1/publish/test-stream", {
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv(mockDoNamespace));

      expect(mockDoFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          url: "http://do/publish",
        }),
      );
    });

    it("passes Content-Type header to DO", async () => {
      const mockResponse = createMockDoResponse();
      const mockDoFetch = createMockDoFetch(mockResponse);
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      const app = await createTestApp();
      await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "plain text",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv(mockDoNamespace));

      const doRequest = mockDoFetch.mock.calls[0][0] as Request;
      expect(doRequest.headers.get("Content-Type")).toBe("text/plain");
    });

    it("passes X-Stream-Id header to DO", async () => {
      const mockResponse = createMockDoResponse();
      const mockDoFetch = createMockDoFetch(mockResponse);
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      const app = await createTestApp();
      await app.request("/v1/publish/target-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv(mockDoNamespace));

      const doRequest = mockDoFetch.mock.calls[0][0] as Request;
      expect(doRequest.headers.get("X-Stream-Id")).toBe("target-stream");
    });
  });

  describe("producer headers (idempotency)", () => {
    it("passes Producer-Id header when present", async () => {
      const mockResponse = createMockDoResponse();
      const mockDoFetch = createMockDoFetch(mockResponse);
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      const app = await createTestApp();
      await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": "producer-1",
        },
      }, createMockEnv(mockDoNamespace));

      const doRequest = mockDoFetch.mock.calls[0][0] as Request;
      expect(doRequest.headers.get("Producer-Id")).toBe("producer-1");
    });

    it("passes Producer-Epoch header when present", async () => {
      const mockResponse = createMockDoResponse();
      const mockDoFetch = createMockDoFetch(mockResponse);
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      const app = await createTestApp();
      await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Epoch": "5",
        },
      }, createMockEnv(mockDoNamespace));

      const doRequest = mockDoFetch.mock.calls[0][0] as Request;
      expect(doRequest.headers.get("Producer-Epoch")).toBe("5");
    });

    it("passes Producer-Seq header when present", async () => {
      const mockResponse = createMockDoResponse();
      const mockDoFetch = createMockDoFetch(mockResponse);
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      const app = await createTestApp();
      await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Seq": "123",
        },
      }, createMockEnv(mockDoNamespace));

      const doRequest = mockDoFetch.mock.calls[0][0] as Request;
      expect(doRequest.headers.get("Producer-Seq")).toBe("123");
    });

    it("passes all producer headers together", async () => {
      const mockResponse = createMockDoResponse();
      const mockDoFetch = createMockDoFetch(mockResponse);
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

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
      }, createMockEnv(mockDoNamespace));

      const doRequest = mockDoFetch.mock.calls[0][0] as Request;
      expect(doRequest.headers.get("Producer-Id")).toBe("producer-1");
      expect(doRequest.headers.get("Producer-Epoch")).toBe("1");
      expect(doRequest.headers.get("Producer-Seq")).toBe("42");
    });
  });

  describe("error handling", () => {
    it("returns DO error response status", async () => {
      const mockResponse = createMockDoResponse({
        ok: false,
        status: 500,
        body: JSON.stringify({ error: "Failed to write to stream" }),
      });
      const mockDoFetch = createMockDoFetch(mockResponse);
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      const app = await createTestApp();
      const res = await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv(mockDoNamespace));

      expect(res.status).toBe(500);
    });

    it("records publishError metric on failure", async () => {
      const { createMetrics } = await import("../../src/metrics");

      const mockMetrics = {
        publish: vi.fn(),
        publishError: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as unknown as ReturnType<typeof createMetrics>);

      const mockResponse = createMockDoResponse({
        ok: false,
        status: 503,
        body: JSON.stringify({ error: "Service unavailable" }),
      });
      const mockDoFetch = createMockDoFetch(mockResponse);
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      const app = await createTestApp();
      await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv(mockDoNamespace));

      expect(mockMetrics.publishError).toHaveBeenCalledWith(
        "my-stream",
        "http_503",
        expect.any(Number),
      );
    });

    it("returns 400 for DO 400 response", async () => {
      const mockResponse = createMockDoResponse({ ok: false, status: 400 });
      const mockDoFetch = createMockDoFetch(mockResponse);
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      const app = await createTestApp();
      const res = await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv(mockDoNamespace));

      expect(res.status).toBe(400);
    });

    it("returns 404 for DO 404 response", async () => {
      const mockResponse = createMockDoResponse({ ok: false, status: 404 });
      const mockDoFetch = createMockDoFetch(mockResponse);
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      const app = await createTestApp();
      const res = await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv(mockDoNamespace));

      expect(res.status).toBe(404);
    });
  });

  describe("response", () => {
    it("returns DO response body on success", async () => {
      const mockResponse = createMockDoResponse({
        body: JSON.stringify({ offset: 42 }),
      });
      const mockDoFetch = createMockDoFetch(mockResponse);
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      const app = await createTestApp();
      const res = await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv(mockDoNamespace));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ offset: 42 });
    });

    it("preserves DO response headers", async () => {
      const mockResponse = createMockDoResponse({
        headers: {
          "X-Stream-Next-Offset": "999",
          "X-Fanout-Count": "5",
          "X-Fanout-Successes": "4",
          "X-Fanout-Failures": "1",
        },
      });
      const mockDoFetch = createMockDoFetch(mockResponse);
      const mockDoNamespace = createMockDoNamespace(mockDoFetch);

      const app = await createTestApp();
      const res = await app.request("/v1/publish/my-stream", {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv(mockDoNamespace));

      expect(res.headers.get("X-Stream-Next-Offset")).toBe("999");
      expect(res.headers.get("X-Fanout-Count")).toBe("5");
      expect(res.headers.get("X-Fanout-Successes")).toBe("4");
      expect(res.headers.get("X-Fanout-Failures")).toBe("1");
    });
  });
});
