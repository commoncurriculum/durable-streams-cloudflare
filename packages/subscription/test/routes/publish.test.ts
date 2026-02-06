import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { PublishResult } from "../../src/subscriptions/types";
import type { AppEnv } from "../../src/env";

// Mock service function
const mockPublish = vi.fn();

vi.mock("../../src/subscriptions/publish", () => ({
  publish: (...args: unknown[]) => mockPublish(...args),
}));

// Mock metrics
vi.mock("../../src/metrics", () => ({
  createMetrics: vi.fn(() => ({
    publishError: vi.fn(),
  })),
}));

const PROJECT_ID = "test-project";

function createTestApp() {
  return import("../../src/http/routes/publish").then(({ publishRoutes }) => {
    const app = new Hono();
    app.route(`/v1/:project`, publishRoutes);
    return app;
  });
}

function createMockEnv() {
  return {
    CORE: {
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    },
    SUBSCRIPTION_DO: {} as AppEnv["SUBSCRIPTION_DO"],
    METRICS: {} as AnalyticsEngineDataset,
  };
}

function createPublishResult(overrides: Partial<PublishResult> = {}): PublishResult {
  return {
    status: 200,
    nextOffset: null,
    upToDate: null,
    streamClosed: null,
    body: "{}",
    fanoutCount: 0,
    fanoutSuccesses: 0,
    fanoutFailures: 0,
    fanoutMode: "inline",
    ...overrides,
  };
}

describe("POST /publish/:streamId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("streamId validation", () => {
    it("rejects invalid streamId with semicolon", async () => {
      const app = await createTestApp();
      // URL-encode the semicolon so it reaches the handler as part of the streamId
      const response = await app.request(`/v1/${PROJECT_ID}/publish/bad%3Bid`, {
        method: "POST",
        body: JSON.stringify({ data: "test" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(response.status).toBe(400);
      // Zod validation returns error in 'success' and 'error' fields with array of issues
      const body = await response.json() as { success: boolean; error?: { issues: Array<{ message: string }> } };
      expect(body.success).toBe(false);
    });

    it("rejects streamId with SQL-like content", async () => {
      const app = await createTestApp();
      const response = await app.request(`/v1/${PROJECT_ID}/publish/'; DROP TABLE --`, {
        method: "POST",
        body: JSON.stringify({ data: "test" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(response.status).toBe(400);
    });

    it("rejects streamId with quotes", async () => {
      const app = await createTestApp();
      const response = await app.request(`/v1/${PROJECT_ID}/publish/test'id`, {
        method: "POST",
        body: JSON.stringify({ data: "test" }),
        headers: { "Content-Type": "application/json" },
      }, createMockEnv());

      expect(response.status).toBe(400);
    });

    it("accepts valid streamId formats", async () => {
      mockPublish.mockResolvedValue(createPublishResult());

      const app = await createTestApp();
      const validIds = ["stream-123", "my_stream", "user:stream:1", "Stream.Name.123"];
      for (const id of validIds) {
        const response = await app.request(`/v1/${PROJECT_ID}/publish/${encodeURIComponent(id)}`, {
          method: "POST",
          body: JSON.stringify({ data: "test" }),
          headers: { "Content-Type": "application/json" },
        }, createMockEnv());
        expect(response.status).not.toBe(400);
      }
    });
  });

  describe("routing to publish service", () => {
    it("calls publish service with correct streamId", async () => {
      mockPublish.mockResolvedValue(createPublishResult());

      const app = await createTestApp();
      const env = createMockEnv();
      await app.request(`/v1/${PROJECT_ID}/publish/my-stream-id`, {
        method: "POST",
        body: JSON.stringify({ data: "test" }),
        headers: { "Content-Type": "application/json" },
      }, env);

      expect(mockPublish).toHaveBeenCalledWith(
        env,
        PROJECT_ID,
        "my-stream-id",
        expect.objectContaining({
          contentType: "application/json",
        }),
      );
    });

    it("passes Content-Type to publish service", async () => {
      mockPublish.mockResolvedValue(createPublishResult());

      const app = await createTestApp();
      await app.request(`/v1/${PROJECT_ID}/publish/my-stream`, {
        method: "POST",
        body: "plain text",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(mockPublish).toHaveBeenCalledWith(
        expect.anything(),
        PROJECT_ID,
        "my-stream",
        expect.objectContaining({
          contentType: "text/plain",
        }),
      );
    });
  });

  describe("producer headers (idempotency)", () => {
    it("passes Producer-Id when present", async () => {
      mockPublish.mockResolvedValue(createPublishResult());

      const app = await createTestApp();
      await app.request(`/v1/${PROJECT_ID}/publish/my-stream`, {
        method: "POST",
        body: "test",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": "producer-1",
        },
      }, createMockEnv());

      expect(mockPublish).toHaveBeenCalledWith(
        expect.anything(),
        PROJECT_ID,
        "my-stream",
        expect.objectContaining({
          producerId: "producer-1",
        }),
      );
    });

    it("passes Producer-Epoch when present", async () => {
      mockPublish.mockResolvedValue(createPublishResult());

      const app = await createTestApp();
      await app.request(`/v1/${PROJECT_ID}/publish/my-stream`, {
        method: "POST",
        body: "test",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Epoch": "5",
        },
      }, createMockEnv());

      expect(mockPublish).toHaveBeenCalledWith(
        expect.anything(),
        PROJECT_ID,
        "my-stream",
        expect.objectContaining({
          producerEpoch: "5",
        }),
      );
    });

    it("passes Producer-Seq when present", async () => {
      mockPublish.mockResolvedValue(createPublishResult());

      const app = await createTestApp();
      await app.request(`/v1/${PROJECT_ID}/publish/my-stream`, {
        method: "POST",
        body: "test",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Seq": "123",
        },
      }, createMockEnv());

      expect(mockPublish).toHaveBeenCalledWith(
        expect.anything(),
        PROJECT_ID,
        "my-stream",
        expect.objectContaining({
          producerSeq: "123",
        }),
      );
    });

    it("passes all producer headers together", async () => {
      mockPublish.mockResolvedValue(createPublishResult());

      const app = await createTestApp();
      await app.request(`/v1/${PROJECT_ID}/publish/my-stream`, {
        method: "POST",
        body: "test",
        headers: {
          "Content-Type": "text/plain",
          "Producer-Id": "producer-1",
          "Producer-Epoch": "1",
          "Producer-Seq": "42",
        },
      }, createMockEnv());

      expect(mockPublish).toHaveBeenCalledWith(
        expect.anything(),
        PROJECT_ID,
        "my-stream",
        expect.objectContaining({
          producerId: "producer-1",
          producerEpoch: "1",
          producerSeq: "42",
        }),
      );
    });
  });

  describe("error handling", () => {
    it("returns publish service error status", async () => {
      mockPublish.mockResolvedValue(createPublishResult({
        status: 500,
        body: JSON.stringify({ error: "Failed to write to stream" }),
      }));

      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/publish/my-stream`, {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(res.status).toBe(500);
    });

    it("records publishError metric on failure", async () => {
      const { createMetrics } = await import("../../src/metrics");

      const mockMetrics = {
        publishError: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as unknown as ReturnType<typeof createMetrics>);

      mockPublish.mockResolvedValue(createPublishResult({
        status: 503,
        body: JSON.stringify({ error: "Service unavailable" }),
      }));

      const app = await createTestApp();
      await app.request(`/v1/${PROJECT_ID}/publish/my-stream`, {
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

    it("returns 400 for publish result with 400 status", async () => {
      mockPublish.mockResolvedValue(createPublishResult({ status: 400 }));

      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/publish/my-stream`, {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(res.status).toBe(400);
    });

    it("returns 404 for publish result with 404 status", async () => {
      mockPublish.mockResolvedValue(createPublishResult({ status: 404 }));

      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/publish/my-stream`, {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(res.status).toBe(404);
    });

    it("returns 500 when publish service throws", async () => {
      mockPublish.mockRejectedValue(new Error("DO unavailable"));

      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/publish/my-stream`, {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Failed to publish");
    });
  });

  describe("response", () => {
    it("returns publish result body on success", async () => {
      mockPublish.mockResolvedValue(createPublishResult({
        body: JSON.stringify({ offset: 42 }),
      }));

      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/publish/my-stream`, {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ offset: 42 });
    });

    it("sets response headers from publish result", async () => {
      mockPublish.mockResolvedValue(createPublishResult({
        nextOffset: "999",
        fanoutCount: 5,
        fanoutSuccesses: 4,
        fanoutFailures: 1,
      }));

      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/publish/my-stream`, {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(res.headers.get("X-Stream-Next-Offset")).toBe("999");
      expect(res.headers.get("X-Fanout-Count")).toBe("5");
      expect(res.headers.get("X-Fanout-Successes")).toBe("4");
      expect(res.headers.get("X-Fanout-Failures")).toBe("1");
      expect(res.headers.get("X-Fanout-Mode")).toBe("inline");
    });

    it("sets X-Fanout-Mode header to queued when fanout was queued", async () => {
      mockPublish.mockResolvedValue(createPublishResult({
        fanoutCount: 500,
        fanoutMode: "queued",
      }));

      const app = await createTestApp();
      const res = await app.request(`/v1/${PROJECT_ID}/publish/my-stream`, {
        method: "POST",
        body: "test",
        headers: { "Content-Type": "text/plain" },
      }, createMockEnv());

      expect(res.headers.get("X-Fanout-Mode")).toBe("queued");
    });
  });
});
