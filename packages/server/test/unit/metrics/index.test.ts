import { describe, it, expect, vi, beforeEach } from "vitest";
import { Metrics, createMetrics } from "../../../src/metrics/index";

// ============================================================================
// Mock Analytics Engine Dataset
// ============================================================================

function createMockAnalyticsEngine() {
  return {
    writeDataPoint: vi.fn(),
  };
}

// ============================================================================
// Metrics Constructor
// ============================================================================

describe("Metrics constructor", () => {
  it("accepts an Analytics Engine dataset", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);
    expect(metrics).toBeInstanceOf(Metrics);
  });

  it("accepts undefined Analytics Engine dataset", () => {
    const metrics = new Metrics(undefined);
    expect(metrics).toBeInstanceOf(Metrics);
  });
});

// ============================================================================
// createMetrics Factory
// ============================================================================

describe("createMetrics factory", () => {
  it("creates a Metrics instance with Analytics Engine dataset", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = createMetrics(ae);
    expect(metrics).toBeInstanceOf(Metrics);
  });

  it("creates a Metrics instance with undefined Analytics Engine dataset", () => {
    const metrics = createMetrics(undefined);
    expect(metrics).toBeInstanceOf(Metrics);
  });
});

// ============================================================================
// fanout Method
// ============================================================================

describe("Metrics.fanout", () => {
  it("writes data point with all parameters", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.fanout({
      streamId: "test-stream",
      subscribers: 100,
      success: 95,
      failures: 5,
      latencyMs: 150,
    });

    expect(ae.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["test-stream", "", "fanout", ""],
      doubles: [100, 95, 5, 150],
      indexes: ["fanout"],
    });
  });

  it("handles zero subscribers", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.fanout({
      streamId: "empty-stream",
      subscribers: 0,
      success: 0,
      failures: 0,
      latencyMs: 50,
    });

    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["empty-stream", "", "fanout", ""],
      doubles: [0, 0, 0, 50],
      indexes: ["fanout"],
    });
  });

  it("does not throw when Analytics Engine is undefined", () => {
    const metrics = new Metrics(undefined);

    expect(() => {
      metrics.fanout({
        streamId: "test-stream",
        subscribers: 100,
        success: 95,
        failures: 5,
        latencyMs: 150,
      });
    }).not.toThrow();
  });
});

// ============================================================================
// fanoutQueued Method
// ============================================================================

describe("Metrics.fanoutQueued", () => {
  it("writes data point with all parameters", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.fanoutQueued("test-stream", 50, 200);

    expect(ae.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["test-stream", "", "fanout_queued", ""],
      doubles: [50, 200, 0, 0],
      indexes: ["fanout"],
    });
  });

  it("handles zero subscribers", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.fanoutQueued("empty-stream", 0, 10);

    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["empty-stream", "", "fanout_queued", ""],
      doubles: [0, 10, 0, 0],
      indexes: ["fanout"],
    });
  });

  it("does not throw when Analytics Engine is undefined", () => {
    const metrics = new Metrics(undefined);

    expect(() => {
      metrics.fanoutQueued("test-stream", 50, 200);
    }).not.toThrow();
  });
});

// ============================================================================
// subscribe Method
// ============================================================================

describe("Metrics.subscribe", () => {
  it("writes data point for new estuary", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.subscribe("test-stream", "estuary-123", true, 100);

    expect(ae.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["test-stream", "estuary-123", "subscribe", ""],
      doubles: [1, 100, 1, 0],
      indexes: ["subscription"],
    });
  });

  it("writes data point for existing estuary", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.subscribe("test-stream", "estuary-456", false, 75);

    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["test-stream", "estuary-456", "subscribe", ""],
      doubles: [1, 75, 0, 0],
      indexes: ["subscription"],
    });
  });

  it("does not throw when Analytics Engine is undefined", () => {
    const metrics = new Metrics(undefined);

    expect(() => {
      metrics.subscribe("test-stream", "estuary-123", true, 100);
    }).not.toThrow();
  });
});

// ============================================================================
// unsubscribe Method
// ============================================================================

describe("Metrics.unsubscribe", () => {
  it("writes data point with all parameters", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.unsubscribe("test-stream", "estuary-789", 120);

    expect(ae.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["test-stream", "estuary-789", "unsubscribe", ""],
      doubles: [1, 120, 0, 0],
      indexes: ["subscription"],
    });
  });

  it("does not throw when Analytics Engine is undefined", () => {
    const metrics = new Metrics(undefined);

    expect(() => {
      metrics.unsubscribe("test-stream", "estuary-789", 120);
    }).not.toThrow();
  });
});

// ============================================================================
// estuaryCreate Method
// ============================================================================

describe("Metrics.estuaryCreate", () => {
  it("writes data point with all parameters", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.estuaryCreate("estuary-abc", "my-project", 3600, 80);

    expect(ae.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["my-project", "estuary-abc", "estuary_create", ""],
      doubles: [1, 80, 3600, 0],
      indexes: ["estuary"],
    });
  });

  it("handles different TTL values", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.estuaryCreate("estuary-def", "another-project", 7200, 90);

    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["another-project", "estuary-def", "estuary_create", ""],
      doubles: [1, 90, 7200, 0],
      indexes: ["estuary"],
    });
  });

  it("does not throw when Analytics Engine is undefined", () => {
    const metrics = new Metrics(undefined);

    expect(() => {
      metrics.estuaryCreate("estuary-abc", "my-project", 3600, 80);
    }).not.toThrow();
  });
});

// ============================================================================
// estuaryGet Method
// ============================================================================

describe("Metrics.estuaryGet", () => {
  it("writes data point with all parameters", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.estuaryGet("estuary-xyz", 45);

    expect(ae.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["", "estuary-xyz", "estuary_get", ""],
      doubles: [1, 45, 0, 0],
      indexes: ["estuary"],
    });
  });

  it("handles zero latency", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.estuaryGet("estuary-fast", 0);

    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["", "estuary-fast", "estuary_get", ""],
      doubles: [1, 0, 0, 0],
      indexes: ["estuary"],
    });
  });

  it("does not throw when Analytics Engine is undefined", () => {
    const metrics = new Metrics(undefined);

    expect(() => {
      metrics.estuaryGet("estuary-xyz", 45);
    }).not.toThrow();
  });
});

// ============================================================================
// estuaryDelete Method
// ============================================================================

describe("Metrics.estuaryDelete", () => {
  it("writes data point with all parameters", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.estuaryDelete("estuary-delete", 65);

    expect(ae.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["", "estuary-delete", "estuary_delete", ""],
      doubles: [1, 65, 0, 0],
      indexes: ["estuary"],
    });
  });

  it("does not throw when Analytics Engine is undefined", () => {
    const metrics = new Metrics(undefined);

    expect(() => {
      metrics.estuaryDelete("estuary-delete", 65);
    }).not.toThrow();
  });
});

// ============================================================================
// estuaryExpire Method
// ============================================================================

describe("Metrics.estuaryExpire", () => {
  it("writes data point with all parameters", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.estuaryExpire("estuary-expire", 25, 3600000);

    expect(ae.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["", "estuary-expire", "estuary_expire", ""],
      doubles: [1, 0, 25, 3600000],
      indexes: ["estuary"],
    });
  });

  it("handles zero subscriptions", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.estuaryExpire("estuary-no-subs", 0, 7200000);

    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["", "estuary-no-subs", "estuary_expire", ""],
      doubles: [1, 0, 0, 7200000],
      indexes: ["estuary"],
    });
  });

  it("does not throw when Analytics Engine is undefined", () => {
    const metrics = new Metrics(undefined);

    expect(() => {
      metrics.estuaryExpire("estuary-expire", 25, 3600000);
    }).not.toThrow();
  });
});

// ============================================================================
// cleanupBatch Method
// ============================================================================

describe("Metrics.cleanupBatch", () => {
  it("writes data point with all parameters", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.cleanupBatch({
      expiredEstuaries: 10,
      streamsDeleted: 5,
      subscriptionsRemoved: 20,
      subscriptionsFailed: 2,
      latencyMs: 500,
    });

    expect(ae.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["", "", "cleanup_batch", ""],
      doubles: [10, 5, 20, 2, 500],
      indexes: ["cleanup"],
    });
  });

  it("handles zero values", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.cleanupBatch({
      expiredEstuaries: 0,
      streamsDeleted: 0,
      subscriptionsRemoved: 0,
      subscriptionsFailed: 0,
      latencyMs: 100,
    });

    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["", "", "cleanup_batch", ""],
      doubles: [0, 0, 0, 0, 100],
      indexes: ["cleanup"],
    });
  });

  it("does not throw when Analytics Engine is undefined", () => {
    const metrics = new Metrics(undefined);

    expect(() => {
      metrics.cleanupBatch({
        expiredEstuaries: 10,
        streamsDeleted: 5,
        subscriptionsRemoved: 20,
        subscriptionsFailed: 2,
        latencyMs: 500,
      });
    }).not.toThrow();
  });
});

// ============================================================================
// http Method
// ============================================================================

describe("Metrics.http", () => {
  it("writes data point with all parameters", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.http("/v1/stream/test", "GET", 200, 75);

    expect(ae.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["/v1/stream/test", "GET", "200", ""],
      doubles: [1, 75, 0, 0],
      indexes: ["http"],
    });
  });

  it("handles different HTTP methods and status codes", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.http("/v1/stream/test", "POST", 201, 120);

    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["/v1/stream/test", "POST", "201", ""],
      doubles: [1, 120, 0, 0],
      indexes: ["http"],
    });
  });

  it("handles error status codes", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.http("/v1/stream/not-found", "GET", 404, 30);

    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["/v1/stream/not-found", "GET", "404", ""],
      doubles: [1, 30, 0, 0],
      indexes: ["http"],
    });
  });

  it("does not throw when Analytics Engine is undefined", () => {
    const metrics = new Metrics(undefined);

    expect(() => {
      metrics.http("/v1/stream/test", "GET", 200, 75);
    }).not.toThrow();
  });
});

// ============================================================================
// publish Method
// ============================================================================

describe("Metrics.publish", () => {
  it("writes data point with all parameters", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.publish("publish-stream", 15, 200);

    expect(ae.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["publish-stream", "", "publish", ""],
      doubles: [1, 15, 200, 0],
      indexes: ["publish"],
    });
  });

  it("handles zero fanout count", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.publish("no-subscribers", 0, 50);

    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["no-subscribers", "", "publish", ""],
      doubles: [1, 0, 50, 0],
      indexes: ["publish"],
    });
  });

  it("does not throw when Analytics Engine is undefined", () => {
    const metrics = new Metrics(undefined);

    expect(() => {
      metrics.publish("publish-stream", 15, 200);
    }).not.toThrow();
  });
});

// ============================================================================
// publishError Method
// ============================================================================

describe("Metrics.publishError", () => {
  it("writes data point with all parameters", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.publishError("error-stream", "validation_error", 100);

    expect(ae.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["error-stream", "", "publish_error", "validation_error"],
      doubles: [1, 100, 0, 0],
      indexes: ["publish_error"],
    });
  });

  it("handles different error types", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.publishError("timeout-stream", "timeout", 5000);

    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["timeout-stream", "", "publish_error", "timeout"],
      doubles: [1, 5000, 0, 0],
      indexes: ["publish_error"],
    });
  });

  it("does not throw when Analytics Engine is undefined", () => {
    const metrics = new Metrics(undefined);

    expect(() => {
      metrics.publishError("error-stream", "validation_error", 100);
    }).not.toThrow();
  });
});

// ============================================================================
// Integration: Multiple method calls
// ============================================================================

describe("Metrics - multiple calls", () => {
  let ae: ReturnType<typeof createMockAnalyticsEngine>;
  let metrics: Metrics;

  beforeEach(() => {
    ae = createMockAnalyticsEngine();
    metrics = new Metrics(ae);
  });

  it("tracks multiple different events", () => {
    metrics.http("/v1/stream/test", "GET", 200, 50);
    metrics.publish("test-stream", 5, 100);
    metrics.fanout({
      streamId: "test-stream",
      subscribers: 5,
      success: 5,
      failures: 0,
      latencyMs: 80,
    });

    expect(ae.writeDataPoint).toHaveBeenCalledTimes(3);
  });

  it("tracks subscription lifecycle", () => {
    metrics.estuaryCreate("estuary-1", "project-1", 3600, 50);
    metrics.subscribe("stream-1", "estuary-1", true, 60);
    metrics.unsubscribe("stream-1", "estuary-1", 40);
    metrics.estuaryDelete("estuary-1", 30);

    expect(ae.writeDataPoint).toHaveBeenCalledTimes(4);
  });

  it("tracks cleanup operations", () => {
    metrics.estuaryExpire("estuary-old", 10, 7200000);
    metrics.cleanupBatch({
      expiredEstuaries: 5,
      streamsDeleted: 3,
      subscriptionsRemoved: 15,
      subscriptionsFailed: 1,
      latencyMs: 300,
    });

    expect(ae.writeDataPoint).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("Metrics - edge cases", () => {
  it("handles empty string parameters", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.subscribe("", "", true, 0);

    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["", "", "subscribe", ""],
      doubles: [1, 0, 1, 0],
      indexes: ["subscription"],
    });
  });

  it("handles very large numbers", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.fanout({
      streamId: "popular-stream",
      subscribers: 1_000_000,
      success: 999_999,
      failures: 1,
      latencyMs: 10_000,
    });

    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["popular-stream", "", "fanout", ""],
      doubles: [1_000_000, 999_999, 1, 10_000],
      indexes: ["fanout"],
    });
  });

  it("handles special characters in stream IDs", () => {
    const ae = createMockAnalyticsEngine();
    const metrics = new Metrics(ae);

    metrics.http("/v1/stream/test-stream_123.data", "GET", 200, 50);

    expect(ae.writeDataPoint).toHaveBeenCalledWith({
      blobs: ["/v1/stream/test-stream_123.data", "GET", "200", ""],
      doubles: [1, 50, 0, 0],
      indexes: ["http"],
    });
  });
});
