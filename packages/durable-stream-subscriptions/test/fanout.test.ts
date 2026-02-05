import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock storage module
vi.mock("../src/storage", () => ({
  getStreamSubscribers: vi.fn(),
}));

// Mock metrics module
vi.mock("../src/metrics", () => ({
  createMetrics: vi.fn(() => ({
    fanout: vi.fn(),
    fanoutFailure: vi.fn(),
    queueRetry: vi.fn(),
    queueBatch: vi.fn(),
  })),
}));

// Mock core-client module
vi.mock("../src/core-client", () => ({
  fetchFromCore: vi.fn(),
}));

// Helper to create mock env
function createMockEnv(overrides?: Partial<{
  FANOUT_THRESHOLD: string;
  FANOUT_QUEUE: Queue<unknown>;
}>) {
  return {
    DB: {} as D1Database,
    CORE_URL: "http://localhost:8787",
    METRICS: {} as AnalyticsEngineDataset,
    ...overrides,
  };
}

// Helper to create mock queue message
function createMockMessage(body: {
  sessionId: string;
  streamId: string;
  payload: string;
  contentType: string;
}, attempts = 1) {
  return {
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

describe("processQueueBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("success paths", () => {
    it("acks message and increments succeeded on 200 response", async () => {
      const { processQueueBatch } = await import("../src/fanout");
      const { fetchFromCore } = await import("../src/core-client");

      vi.mocked(fetchFromCore).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const env = createMockEnv();
      const msg = createMockMessage({
        sessionId: "session-1",
        streamId: "stream-1",
        payload: btoa("test payload"),
        contentType: "application/json",
      });

      const result = await processQueueBatch(env as any, [msg] as any);

      expect(msg.ack).toHaveBeenCalledTimes(1);
      expect(msg.retry).not.toHaveBeenCalled();
      expect(result.succeeded).toBe(1);
      expect(result.retried).toBe(0);
      expect(result.processed).toBe(1);
    });

    it("acks message and increments succeeded on 404 response (stale subscription)", async () => {
      const { processQueueBatch } = await import("../src/fanout");
      const { fetchFromCore } = await import("../src/core-client");

      vi.mocked(fetchFromCore).mockResolvedValue({
        ok: false,
        status: 404,
      } as Response);

      const env = createMockEnv();
      const msg = createMockMessage({
        sessionId: "deleted-session",
        streamId: "stream-1",
        payload: btoa("test"),
        contentType: "application/json",
      });

      const result = await processQueueBatch(env as any, [msg] as any);

      expect(msg.ack).toHaveBeenCalledTimes(1);
      expect(msg.retry).not.toHaveBeenCalled();
      expect(result.succeeded).toBe(1);
    });

    it("acks message on 4xx client errors (except 404) to avoid infinite loops", async () => {
      const { processQueueBatch } = await import("../src/fanout");
      const { fetchFromCore } = await import("../src/core-client");

      vi.mocked(fetchFromCore).mockResolvedValue({
        ok: false,
        status: 400,
      } as Response);

      const env = createMockEnv();
      const msg = createMockMessage({
        sessionId: "session-1",
        streamId: "stream-1",
        payload: btoa("test"),
        contentType: "application/json",
      });

      const result = await processQueueBatch(env as any, [msg] as any);

      expect(msg.ack).toHaveBeenCalledTimes(1);
      expect(msg.retry).not.toHaveBeenCalled();
      expect(result.succeeded).toBe(1);
    });
  });

  describe("retry paths", () => {
    it("calls queueRetry metric on 5xx server error with correct streamId, sessionId, attempt", async () => {
      const { processQueueBatch } = await import("../src/fanout");
      const { fetchFromCore } = await import("../src/core-client");
      const { createMetrics } = await import("../src/metrics");

      vi.mocked(fetchFromCore).mockResolvedValue({
        ok: false,
        status: 503,
      } as Response);

      const mockMetrics = {
        fanout: vi.fn(),
        fanoutFailure: vi.fn(),
        queueRetry: vi.fn(),
        queueBatch: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

      const env = createMockEnv();
      const msg = createMockMessage(
        {
          sessionId: "session-1",
          streamId: "stream-1",
          payload: btoa("test"),
          contentType: "application/json",
        },
        3, // attempt 3
      );

      await processQueueBatch(env as any, [msg] as any);

      expect(mockMetrics.queueRetry).toHaveBeenCalledWith(
        "stream-1",
        "session-1",
        3,
        "http_503",
      );
    });

    it("calls msg.retry with 5 second delay on 5xx errors", async () => {
      const { processQueueBatch } = await import("../src/fanout");
      const { fetchFromCore } = await import("../src/core-client");

      vi.mocked(fetchFromCore).mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      const env = createMockEnv();
      const msg = createMockMessage({
        sessionId: "session-1",
        streamId: "stream-1",
        payload: btoa("test"),
        contentType: "application/json",
      });

      await processQueueBatch(env as any, [msg] as any);

      expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
      expect(msg.ack).not.toHaveBeenCalled();
    });

    it("calls queueRetry metric on fetch exception with error type 'exception'", async () => {
      const { processQueueBatch } = await import("../src/fanout");
      const { fetchFromCore } = await import("../src/core-client");
      const { createMetrics } = await import("../src/metrics");

      vi.mocked(fetchFromCore).mockRejectedValue(new Error("Network error"));

      const mockMetrics = {
        fanout: vi.fn(),
        fanoutFailure: vi.fn(),
        queueRetry: vi.fn(),
        queueBatch: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

      const env = createMockEnv();
      const msg = createMockMessage(
        {
          sessionId: "session-1",
          streamId: "stream-1",
          payload: btoa("test"),
          contentType: "application/json",
        },
        2,
      );

      await processQueueBatch(env as any, [msg] as any);

      expect(mockMetrics.queueRetry).toHaveBeenCalledWith(
        "stream-1",
        "session-1",
        2,
        "exception",
      );
    });

    it("calls msg.retry with 10 second delay on exceptions", async () => {
      const { processQueueBatch } = await import("../src/fanout");
      const { fetchFromCore } = await import("../src/core-client");

      vi.mocked(fetchFromCore).mockRejectedValue(new Error("Network error"));

      const env = createMockEnv();
      const msg = createMockMessage({
        sessionId: "session-1",
        streamId: "stream-1",
        payload: btoa("test"),
        contentType: "application/json",
      });

      await processQueueBatch(env as any, [msg] as any);

      expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    });

    it("passes msg.attempts to queueRetry metric (defaults to 1 if undefined)", async () => {
      const { processQueueBatch } = await import("../src/fanout");
      const { fetchFromCore } = await import("../src/core-client");
      const { createMetrics } = await import("../src/metrics");

      vi.mocked(fetchFromCore).mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      const mockMetrics = {
        fanout: vi.fn(),
        fanoutFailure: vi.fn(),
        queueRetry: vi.fn(),
        queueBatch: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

      const env = createMockEnv();
      const msg = {
        body: {
          sessionId: "session-1",
          streamId: "stream-1",
          payload: btoa("test"),
          contentType: "application/json",
        },
        attempts: undefined,
        ack: vi.fn(),
        retry: vi.fn(),
      };

      await processQueueBatch(env as any, [msg] as any);

      expect(mockMetrics.queueRetry).toHaveBeenCalledWith(
        "stream-1",
        "session-1",
        1, // defaults to 1
        "http_500",
      );
    });
  });

  describe("aggregation", () => {
    it("returns correct processed, succeeded, retried counts", async () => {
      const { processQueueBatch } = await import("../src/fanout");
      const { fetchFromCore } = await import("../src/core-client");

      vi.mocked(fetchFromCore)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
        .mockResolvedValueOnce({ ok: false, status: 500 } as Response);

      const env = createMockEnv();
      const messages = [
        createMockMessage({ sessionId: "s1", streamId: "str1", payload: btoa("1"), contentType: "application/json" }),
        createMockMessage({ sessionId: "s2", streamId: "str1", payload: btoa("2"), contentType: "application/json" }),
        createMockMessage({ sessionId: "s3", streamId: "str1", payload: btoa("3"), contentType: "application/json" }),
      ];

      const result = await processQueueBatch(env as any, messages as any);

      expect(result.processed).toBe(3);
      expect(result.succeeded).toBe(2);
      expect(result.retried).toBe(1);
    });

    it("handles mixed success/failure batch correctly", async () => {
      const { processQueueBatch } = await import("../src/fanout");
      const { fetchFromCore } = await import("../src/core-client");

      vi.mocked(fetchFromCore)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
        .mockResolvedValueOnce({ ok: false, status: 404 } as Response) // success (acked)
        .mockResolvedValueOnce({ ok: false, status: 400 } as Response) // success (acked)
        .mockResolvedValueOnce({ ok: false, status: 500 } as Response) // retry
        .mockRejectedValueOnce(new Error("timeout")); // retry

      const env = createMockEnv();
      const messages = [
        createMockMessage({ sessionId: "s1", streamId: "str1", payload: btoa("1"), contentType: "application/json" }),
        createMockMessage({ sessionId: "s2", streamId: "str1", payload: btoa("2"), contentType: "application/json" }),
        createMockMessage({ sessionId: "s3", streamId: "str1", payload: btoa("3"), contentType: "application/json" }),
        createMockMessage({ sessionId: "s4", streamId: "str1", payload: btoa("4"), contentType: "application/json" }),
        createMockMessage({ sessionId: "s5", streamId: "str1", payload: btoa("5"), contentType: "application/json" }),
      ];

      const result = await processQueueBatch(env as any, messages as any);

      expect(result.processed).toBe(5);
      expect(result.succeeded).toBe(3);
      expect(result.retried).toBe(2);
    });

    it("processes empty batch without error", async () => {
      const { processQueueBatch } = await import("../src/fanout");

      const env = createMockEnv();

      const result = await processQueueBatch(env as any, []);

      expect(result.processed).toBe(0);
      expect(result.succeeded).toBe(0);
      expect(result.retried).toBe(0);
    });
  });
});

describe("fanOutToSubscribers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("no subscribers", () => {
    it("returns zeros when no subscribers exist", async () => {
      const { fanOutToSubscribers } = await import("../src/fanout");
      const { getStreamSubscribers } = await import("../src/storage");

      vi.mocked(getStreamSubscribers).mockResolvedValue([]);

      const env = createMockEnv();
      const payload = new TextEncoder().encode("test").buffer;

      const result = await fanOutToSubscribers(
        env as any,
        "stream-1",
        payload,
        "application/json",
      );

      expect(result.fanoutCount).toBe(0);
      expect(result.successCount).toBe(0);
      expect(result.failureCount).toBe(0);
    });
  });

  describe("inline fanout (below threshold)", () => {
    it("uses Promise.allSettled for inline fanout below threshold", async () => {
      const { fanOutToSubscribers } = await import("../src/fanout");
      const { getStreamSubscribers } = await import("../src/storage");
      const { fetchFromCore } = await import("../src/core-client");

      vi.mocked(getStreamSubscribers).mockResolvedValue(["session-1", "session-2"]);
      vi.mocked(fetchFromCore).mockResolvedValue({ ok: true, status: 200 } as Response);

      const env = createMockEnv({ FANOUT_THRESHOLD: "100" });
      const payload = new TextEncoder().encode("test").buffer;

      const result = await fanOutToSubscribers(
        env as any,
        "stream-1",
        payload,
        "application/json",
      );

      // Should have called fetchFromCore for each subscriber
      expect(fetchFromCore).toHaveBeenCalledTimes(2);
      expect(result.fanoutCount).toBe(2);
      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(0);
    });

    it("records fanout metric with correct subscriber/success/failure counts", async () => {
      const { fanOutToSubscribers } = await import("../src/fanout");
      const { getStreamSubscribers } = await import("../src/storage");
      const { fetchFromCore } = await import("../src/core-client");
      const { createMetrics } = await import("../src/metrics");

      const mockMetrics = {
        fanout: vi.fn(),
        fanoutFailure: vi.fn(),
        queueRetry: vi.fn(),
        queueBatch: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

      vi.mocked(getStreamSubscribers).mockResolvedValue(["s1", "s2", "s3"]);
      vi.mocked(fetchFromCore)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
        .mockResolvedValueOnce({ ok: false, status: 500 } as Response);

      const env = createMockEnv({ FANOUT_THRESHOLD: "100" });
      const payload = new TextEncoder().encode("test").buffer;

      await fanOutToSubscribers(env as any, "stream-1", payload, "application/json");

      expect(mockMetrics.fanout).toHaveBeenCalledWith(
        "stream-1",
        3, // subscribers
        2, // successes
        1, // failures
        expect.any(Number), // latency
      );
    });

    it("records individual fanoutFailure metrics for rejected promises", async () => {
      const { fanOutToSubscribers } = await import("../src/fanout");
      const { getStreamSubscribers } = await import("../src/storage");
      const { fetchFromCore } = await import("../src/core-client");
      const { createMetrics } = await import("../src/metrics");

      const mockMetrics = {
        fanout: vi.fn(),
        fanoutFailure: vi.fn(),
        queueRetry: vi.fn(),
        queueBatch: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

      vi.mocked(getStreamSubscribers).mockResolvedValue(["s1", "s2"]);
      vi.mocked(fetchFromCore)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
        .mockRejectedValueOnce(new Error("Network error"));

      const env = createMockEnv({ FANOUT_THRESHOLD: "100" });
      const payload = new TextEncoder().encode("test").buffer;

      await fanOutToSubscribers(env as any, "stream-1", payload, "application/json");

      expect(mockMetrics.fanoutFailure).toHaveBeenCalledWith(
        "stream-1",
        "s2",
        "rejected",
        0,
      );
    });

    it("records individual fanoutFailure metrics for non-ok responses", async () => {
      const { fanOutToSubscribers } = await import("../src/fanout");
      const { getStreamSubscribers } = await import("../src/storage");
      const { fetchFromCore } = await import("../src/core-client");
      const { createMetrics } = await import("../src/metrics");

      const mockMetrics = {
        fanout: vi.fn(),
        fanoutFailure: vi.fn(),
        queueRetry: vi.fn(),
        queueBatch: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

      vi.mocked(getStreamSubscribers).mockResolvedValue(["s1", "s2"]);
      vi.mocked(fetchFromCore)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
        .mockResolvedValueOnce({ ok: false, status: 503 } as Response);

      const env = createMockEnv({ FANOUT_THRESHOLD: "100" });
      const payload = new TextEncoder().encode("test").buffer;

      await fanOutToSubscribers(env as any, "stream-1", payload, "application/json");

      expect(mockMetrics.fanoutFailure).toHaveBeenCalledWith(
        "stream-1",
        "s2",
        "http_503",
        0,
      );
    });

    it("passes producer headers to writeToSessionStreamWithEnv", async () => {
      const { fanOutToSubscribers } = await import("../src/fanout");
      const { getStreamSubscribers } = await import("../src/storage");
      const { fetchFromCore } = await import("../src/core-client");

      vi.mocked(getStreamSubscribers).mockResolvedValue(["session-1"]);
      vi.mocked(fetchFromCore).mockResolvedValue({ ok: true, status: 200 } as Response);

      const env = createMockEnv({ FANOUT_THRESHOLD: "100" });
      const payload = new TextEncoder().encode("test").buffer;
      const producerHeaders = {
        "Producer-Id": "fanout:stream-1",
        "Producer-Epoch": "1",
        "Producer-Seq": "42",
      };

      await fanOutToSubscribers(
        env as any,
        "stream-1",
        payload,
        "application/json",
        producerHeaders,
      );

      expect(fetchFromCore).toHaveBeenCalledWith(
        env,
        "/v1/stream/session:session-1",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "Producer-Id": "fanout:stream-1",
            "Producer-Epoch": "1",
            "Producer-Seq": "42",
          }),
        }),
      );
    });
  });

  describe("queue fanout (above threshold)", () => {
    it("uses queue when subscribers exceed threshold", async () => {
      const { fanOutToSubscribers } = await import("../src/fanout");
      const { getStreamSubscribers } = await import("../src/storage");
      const { fetchFromCore } = await import("../src/core-client");

      const sessionIds = Array.from({ length: 150 }, (_, i) => `session-${i}`);
      vi.mocked(getStreamSubscribers).mockResolvedValue(sessionIds);

      const mockQueue = {
        sendBatch: vi.fn().mockResolvedValue(undefined),
      };

      const env = createMockEnv({
        FANOUT_THRESHOLD: "100",
        FANOUT_QUEUE: mockQueue as unknown as Queue<unknown>,
      });
      const payload = new TextEncoder().encode("test").buffer;

      const result = await fanOutToSubscribers(
        env as any,
        "stream-1",
        payload,
        "application/json",
      );

      // Should NOT call fetchFromCore directly - uses queue instead
      expect(fetchFromCore).not.toHaveBeenCalled();
      // Queue should be used
      expect(mockQueue.sendBatch).toHaveBeenCalled();
      expect(result.fanoutCount).toBe(150);
    });

    it("chunks messages into batches of 100", async () => {
      const { fanOutToSubscribers } = await import("../src/fanout");
      const { getStreamSubscribers } = await import("../src/storage");

      const sessionIds = Array.from({ length: 250 }, (_, i) => `session-${i}`);
      vi.mocked(getStreamSubscribers).mockResolvedValue(sessionIds);

      const mockQueue = {
        sendBatch: vi.fn().mockResolvedValue(undefined),
      };

      const env = createMockEnv({
        FANOUT_THRESHOLD: "100",
        FANOUT_QUEUE: mockQueue as unknown as Queue<unknown>,
      });
      const payload = new TextEncoder().encode("test").buffer;

      await fanOutToSubscribers(env as any, "stream-1", payload, "application/json");

      // 250 subscribers = 3 batches (100 + 100 + 50)
      expect(mockQueue.sendBatch).toHaveBeenCalledTimes(3);

      // First batch should have 100 items
      expect(mockQueue.sendBatch.mock.calls[0][0]).toHaveLength(100);
      // Second batch should have 100 items
      expect(mockQueue.sendBatch.mock.calls[1][0]).toHaveLength(100);
      // Third batch should have 50 items
      expect(mockQueue.sendBatch.mock.calls[2][0]).toHaveLength(50);
    });

    it("encodes payload as base64 for queue messages", async () => {
      const { fanOutToSubscribers } = await import("../src/fanout");
      const { getStreamSubscribers } = await import("../src/storage");

      vi.mocked(getStreamSubscribers).mockResolvedValue(
        Array.from({ length: 150 }, (_, i) => `session-${i}`),
      );

      const mockQueue = {
        sendBatch: vi.fn().mockResolvedValue(undefined),
      };

      const env = createMockEnv({
        FANOUT_THRESHOLD: "100",
        FANOUT_QUEUE: mockQueue as unknown as Queue<unknown>,
      });
      const payload = new TextEncoder().encode("hello world").buffer;

      await fanOutToSubscribers(env as any, "stream-1", payload, "text/plain");

      const firstBatch = mockQueue.sendBatch.mock.calls[0][0];
      const firstMessage = firstBatch[0].body;

      expect(firstMessage.payload).toBe(btoa("hello world"));
      expect(firstMessage.streamId).toBe("stream-1");
      expect(firstMessage.contentType).toBe("text/plain");
    });

    it("records fanout metric immediately after queuing", async () => {
      const { fanOutToSubscribers } = await import("../src/fanout");
      const { getStreamSubscribers } = await import("../src/storage");
      const { createMetrics } = await import("../src/metrics");

      vi.mocked(getStreamSubscribers).mockResolvedValue(
        Array.from({ length: 150 }, (_, i) => `session-${i}`),
      );

      const mockMetrics = {
        fanout: vi.fn(),
        fanoutFailure: vi.fn(),
        queueRetry: vi.fn(),
        queueBatch: vi.fn(),
      };
      vi.mocked(createMetrics).mockReturnValue(mockMetrics as any);

      const mockQueue = {
        sendBatch: vi.fn().mockResolvedValue(undefined),
      };

      const env = createMockEnv({
        FANOUT_THRESHOLD: "100",
        FANOUT_QUEUE: mockQueue as unknown as Queue<unknown>,
      });
      const payload = new TextEncoder().encode("test").buffer;

      await fanOutToSubscribers(env as any, "stream-1", payload, "application/json");

      // Queue fanout records success for all queued (fire-and-forget)
      expect(mockMetrics.fanout).toHaveBeenCalledWith(
        "stream-1",
        150, // subscribers
        150, // success (queued = assumed success)
        0, // failures
        expect.any(Number), // latency
      );
    });
  });
});
