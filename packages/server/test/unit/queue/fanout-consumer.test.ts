import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { handleFanoutQueue } from "../../../src/queue/fanout-consumer";
import { bufferToBase64 } from "../../../src/util/base64";
import type { FanoutQueueMessage } from "../../../src/http/v1/estuary/types";
import type { BaseEnv } from "../../../src/http/router";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a test payload buffer from a string
 */
function createPayload(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/**
 * Create a mock queue message with default values
 */
function createMockMessage(
  body: FanoutQueueMessage,
  overrides: Partial<Message<FanoutQueueMessage>> = {},
): Message<FanoutQueueMessage> {
  return {
    id: "test-message-id",
    timestamp: new Date(),
    attempts: 1,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  };
}

/**
 * Create a mock MessageBatch
 */
function createMockBatch(
  messages: Message<FanoutQueueMessage>[],
): MessageBatch<FanoutQueueMessage> {
  return {
    queue: "test-queue",
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}

/**
 * Create a mock Durable Object stub for STREAMS
 */
function createMockStreamStub(response: Response) {
  return {
    routeStreamRequest: vi.fn().mockResolvedValue(response),
  };
}

/**
 * Create a mock Durable Object stub for SUBSCRIPTION_DO
 */
function createMockSubscriptionStub() {
  return {
    removeSubscribers: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Create a mock environment with necessary bindings
 */
function createMockEnv(
  streamStubs: Map<string, ReturnType<typeof createMockStreamStub>> = new Map(),
  subscriptionStub: ReturnType<typeof createMockSubscriptionStub> | null = null,
): BaseEnv {
  const mockEnv = {
    STREAMS: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn((id: { name: string }) => {
        const stub = streamStubs.get(id.name);
        if (!stub) {
          throw new Error(`No mock stub for ${id.name}`);
        }
        return stub;
      }),
    },
    SUBSCRIPTION_DO: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => subscriptionStub),
    },
    ESTUARY_DO: env.ESTUARY_DO,
    REGISTRY: env.REGISTRY,
    METRICS: {
      writeDataPoint: vi.fn(),
    },
  };

  return mockEnv as unknown as BaseEnv;
}

// ============================================================================
// Tests
// ============================================================================

describe("handleFanoutQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================================
  // Happy path — successful fanout
  // ============================================================================

  it("processes a single message with successful fanout", async () => {
    const payload = createPayload("test message");
    const payloadBase64 = bufferToBase64(payload);

    const messageBody: FanoutQueueMessage = {
      projectId: "test-project",
      streamId: "test-stream",
      estuaryIds: ["estuary-1", "estuary-2"],
      payload: payloadBase64,
      contentType: "text/plain",
    };

    const message = createMockMessage(messageBody);
    const batch = createMockBatch([message]);

    // Mock successful responses for both estuaries
    const stub1 = createMockStreamStub(new Response("", { status: 200 }));
    const stub2 = createMockStreamStub(new Response("", { status: 200 }));
    const streamStubs = new Map([
      ["test-project/estuary-1", stub1],
      ["test-project/estuary-2", stub2],
    ]);

    const mockEnv = createMockEnv(streamStubs);

    await handleFanoutQueue(batch, mockEnv);

    // Verify fanout calls were made
    expect(stub1.routeStreamRequest).toHaveBeenCalledTimes(1);
    expect(stub2.routeStreamRequest).toHaveBeenCalledTimes(1);

    // Verify message was acked (no stale subscribers, no server errors)
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();

    // Verify metrics were recorded
    expect(mockEnv.METRICS?.writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: ["test-stream", "", "fanout", ""],
        doubles: expect.arrayContaining([2, 2, 0, expect.any(Number)]),
        indexes: ["fanout"],
      }),
    );
  });

  it("processes multiple messages in a batch", async () => {
    const payload1 = createPayload("message 1");
    const payload2 = createPayload("message 2");

    const message1 = createMockMessage({
      projectId: "project-1",
      streamId: "stream-1",
      estuaryIds: ["estuary-1"],
      payload: bufferToBase64(payload1),
      contentType: "text/plain",
    });

    const message2 = createMockMessage({
      projectId: "project-2",
      streamId: "stream-2",
      estuaryIds: ["estuary-2"],
      payload: bufferToBase64(payload2),
      contentType: "application/json",
    });

    const batch = createMockBatch([message1, message2]);

    const streamStubs = new Map([
      ["project-1/estuary-1", createMockStreamStub(new Response("", { status: 200 }))],
      ["project-2/estuary-2", createMockStreamStub(new Response("", { status: 200 }))],
    ]);

    const mockEnv = createMockEnv(streamStubs);

    await handleFanoutQueue(batch, mockEnv);

    expect(message1.ack).toHaveBeenCalledTimes(1);
    expect(message2.ack).toHaveBeenCalledTimes(1);
  });

  it("includes producer headers when present", async () => {
    const payload = createPayload("test");
    const messageBody: FanoutQueueMessage = {
      projectId: "test-project",
      streamId: "test-stream",
      estuaryIds: ["estuary-1"],
      payload: bufferToBase64(payload),
      contentType: "text/plain",
      producerHeaders: {
        producerId: "producer-123",
        producerEpoch: "5",
        producerSeq: "42",
      },
    };

    const message = createMockMessage(messageBody);
    const batch = createMockBatch([message]);

    const stub = createMockStreamStub(new Response("", { status: 200 }));
    const streamStubs = new Map([["test-project/estuary-1", stub]]);

    const mockEnv = createMockEnv(streamStubs);

    await handleFanoutQueue(batch, mockEnv);

    // Verify producer headers were included in the request
    const call = stub.routeStreamRequest.mock.calls[0];
    const request = call[1] as Request;
    expect(request.headers.get("X-Producer-Id")).toBe("producer-123");
    expect(request.headers.get("X-Producer-Epoch")).toBe("5");
    expect(request.headers.get("X-Producer-Seq")).toBe("42");

    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  // ============================================================================
  // Stale subscribers (404 responses)
  // ============================================================================

  it("removes stale subscribers when fanout returns 404", async () => {
    const payload = createPayload("test");
    const messageBody: FanoutQueueMessage = {
      projectId: "test-project",
      streamId: "test-stream",
      estuaryIds: ["estuary-1", "estuary-2", "estuary-3"],
      payload: bufferToBase64(payload),
      contentType: "text/plain",
    };

    const message = createMockMessage(messageBody);
    const batch = createMockBatch([message]);

    // estuary-1: success, estuary-2: stale (404), estuary-3: success
    const streamStubs = new Map([
      ["test-project/estuary-1", createMockStreamStub(new Response("", { status: 200 }))],
      ["test-project/estuary-2", createMockStreamStub(new Response("Not Found", { status: 404 }))],
      ["test-project/estuary-3", createMockStreamStub(new Response("", { status: 200 }))],
    ]);

    const subscriptionStub = createMockSubscriptionStub();
    const mockEnv = createMockEnv(streamStubs, subscriptionStub);

    await handleFanoutQueue(batch, mockEnv);

    // Verify removeSubscribers was called with the stale estuary ID
    expect(subscriptionStub.removeSubscribers).toHaveBeenCalledTimes(1);
    expect(subscriptionStub.removeSubscribers).toHaveBeenCalledWith(["estuary-2"]);

    // Message should be acked (404 is not a server error)
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();

    // Metrics: 3 subscribers, 2 success, 1 failure
    expect(mockEnv.METRICS?.writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        doubles: expect.arrayContaining([3, 2, 1, expect.any(Number)]),
      }),
    );
  });

  it("does not call removeSubscribers when no stale subscribers", async () => {
    const payload = createPayload("test");
    const messageBody: FanoutQueueMessage = {
      projectId: "test-project",
      streamId: "test-stream",
      estuaryIds: ["estuary-1"],
      payload: bufferToBase64(payload),
      contentType: "text/plain",
    };

    const message = createMockMessage(messageBody);
    const batch = createMockBatch([message]);

    const streamStubs = new Map([
      ["test-project/estuary-1", createMockStreamStub(new Response("", { status: 200 }))],
    ]);

    const subscriptionStub = createMockSubscriptionStub();
    const mockEnv = createMockEnv(streamStubs, subscriptionStub);

    await handleFanoutQueue(batch, mockEnv);

    // No stale subscribers, so removeSubscribers should not be called
    expect(subscriptionStub.removeSubscribers).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("constructs correct DO key for removeSubscribers", async () => {
    const payload = createPayload("test");
    const messageBody: FanoutQueueMessage = {
      projectId: "my-project",
      streamId: "my-stream",
      estuaryIds: ["estuary-1"],
      payload: bufferToBase64(payload),
      contentType: "text/plain",
    };

    const message = createMockMessage(messageBody);
    const batch = createMockBatch([message]);

    const streamStubs = new Map([
      ["my-project/estuary-1", createMockStreamStub(new Response("Not Found", { status: 404 }))],
    ]);

    const subscriptionStub = createMockSubscriptionStub();
    const mockEnv = createMockEnv(streamStubs, subscriptionStub);

    await handleFanoutQueue(batch, mockEnv);

    // Verify the DO key was constructed correctly (project/stream format)
    expect(mockEnv.SUBSCRIPTION_DO.idFromName).toHaveBeenCalledWith("my-project/my-stream");
    expect(subscriptionStub.removeSubscribers).toHaveBeenCalledWith(["estuary-1"]);
  });

  // ============================================================================
  // Server errors — should retry
  // ============================================================================

  it("retries message when fanout returns server error (500)", async () => {
    const payload = createPayload("test");
    const messageBody: FanoutQueueMessage = {
      projectId: "test-project",
      streamId: "test-stream",
      estuaryIds: ["estuary-1"],
      payload: bufferToBase64(payload),
      contentType: "text/plain",
    };

    const message = createMockMessage(messageBody);
    const batch = createMockBatch([message]);

    const streamStubs = new Map([
      [
        "test-project/estuary-1",
        createMockStreamStub(new Response("Internal Server Error", { status: 500 })),
      ],
    ]);

    const mockEnv = createMockEnv(streamStubs);

    await handleFanoutQueue(batch, mockEnv);

    // Server error should trigger retry
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("retries message when fanout returns other error status (409)", async () => {
    const payload = createPayload("test");
    const messageBody: FanoutQueueMessage = {
      projectId: "test-project",
      streamId: "test-stream",
      estuaryIds: ["estuary-1"],
      payload: bufferToBase64(payload),
      contentType: "text/plain",
    };

    const message = createMockMessage(messageBody);
    const batch = createMockBatch([message]);

    const streamStubs = new Map([
      ["test-project/estuary-1", createMockStreamStub(new Response("Conflict", { status: 409 }))],
    ]);

    const mockEnv = createMockEnv(streamStubs);

    await handleFanoutQueue(batch, mockEnv);

    // Non-200, non-404 error should trigger retry
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("acks message when all errors are 404 (all stale)", async () => {
    const payload = createPayload("test");
    const messageBody: FanoutQueueMessage = {
      projectId: "test-project",
      streamId: "test-stream",
      estuaryIds: ["estuary-1", "estuary-2"],
      payload: bufferToBase64(payload),
      contentType: "text/plain",
    };

    const message = createMockMessage(messageBody);
    const batch = createMockBatch([message]);

    // Both estuaries return 404
    const streamStubs = new Map([
      ["test-project/estuary-1", createMockStreamStub(new Response("Not Found", { status: 404 }))],
      ["test-project/estuary-2", createMockStreamStub(new Response("Not Found", { status: 404 }))],
    ]);

    const subscriptionStub = createMockSubscriptionStub();
    const mockEnv = createMockEnv(streamStubs, subscriptionStub);

    await handleFanoutQueue(batch, mockEnv);

    // All failures are stale (404), so ack
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();

    // Both should be removed
    expect(subscriptionStub.removeSubscribers).toHaveBeenCalledWith(["estuary-1", "estuary-2"]);
  });

  it("retries message when mix of 404 and server errors", async () => {
    const payload = createPayload("test");
    const messageBody: FanoutQueueMessage = {
      projectId: "test-project",
      streamId: "test-stream",
      estuaryIds: ["estuary-1", "estuary-2"],
      payload: bufferToBase64(payload),
      contentType: "text/plain",
    };

    const message = createMockMessage(messageBody);
    const batch = createMockBatch([message]);

    // One 404 (stale), one 500 (server error)
    const streamStubs = new Map([
      ["test-project/estuary-1", createMockStreamStub(new Response("Not Found", { status: 404 }))],
      [
        "test-project/estuary-2",
        createMockStreamStub(new Response("Internal Server Error", { status: 500 })),
      ],
    ]);

    const subscriptionStub = createMockSubscriptionStub();
    const mockEnv = createMockEnv(streamStubs, subscriptionStub);

    await handleFanoutQueue(batch, mockEnv);

    // Has server error (1 failure - 1 stale = 1 server error), so retry
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();

    // Still remove the stale subscriber
    expect(subscriptionStub.removeSubscribers).toHaveBeenCalledWith(["estuary-1"]);
  });

  // ============================================================================
  // Exception handling
  // ============================================================================

  it("retries message when base64 decode throws", async () => {
    const messageBody: FanoutQueueMessage = {
      projectId: "test-project",
      streamId: "test-stream",
      estuaryIds: ["estuary-1"],
      payload: "invalid-base64!@#$", // Invalid base64
      contentType: "text/plain",
    };

    const message = createMockMessage(messageBody);
    const batch = createMockBatch([message]);

    const mockEnv = createMockEnv();

    await handleFanoutQueue(batch, mockEnv);

    // Exception during processing should trigger retry
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("retries message when fanoutToSubscribers throws", async () => {
    const payload = createPayload("test");
    const messageBody: FanoutQueueMessage = {
      projectId: "test-project",
      streamId: "test-stream",
      estuaryIds: ["estuary-1"],
      payload: bufferToBase64(payload),
      contentType: "text/plain",
    };

    const message = createMockMessage(messageBody);
    const batch = createMockBatch([message]);

    // Mock stub that throws an error
    const stub = {
      routeStreamRequest: vi.fn().mockRejectedValue(new Error("Network error")),
    };
    const streamStubs = new Map([["test-project/estuary-1", stub]]);

    const mockEnv = createMockEnv(streamStubs);

    await handleFanoutQueue(batch, mockEnv);

    // Exception should trigger retry
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
  });

  // ============================================================================
  // Edge cases
  // ============================================================================

  it("handles empty message batch", async () => {
    const batch = createMockBatch([]);
    const mockEnv = createMockEnv();

    // Should not throw
    await expect(handleFanoutQueue(batch, mockEnv)).resolves.toBeUndefined();
  });

  it("handles message with empty estuaryIds array", async () => {
    const payload = createPayload("test");
    const messageBody: FanoutQueueMessage = {
      projectId: "test-project",
      streamId: "test-stream",
      estuaryIds: [], // No subscribers
      payload: bufferToBase64(payload),
      contentType: "text/plain",
    };

    const message = createMockMessage(messageBody);
    const batch = createMockBatch([message]);

    const mockEnv = createMockEnv(new Map());

    await handleFanoutQueue(batch, mockEnv);

    // Should ack (no subscribers = no failures)
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("handles message without producer headers", async () => {
    const payload = createPayload("test");
    const messageBody: FanoutQueueMessage = {
      projectId: "test-project",
      streamId: "test-stream",
      estuaryIds: ["estuary-1"],
      payload: bufferToBase64(payload),
      contentType: "text/plain",
      // No producerHeaders
    };

    const message = createMockMessage(messageBody);
    const batch = createMockBatch([message]);

    const stub = createMockStreamStub(new Response("", { status: 200 }));
    const streamStubs = new Map([["test-project/estuary-1", stub]]);

    const mockEnv = createMockEnv(streamStubs);

    await handleFanoutQueue(batch, mockEnv);

    // Verify request was made without producer headers
    const call = stub.routeStreamRequest.mock.calls[0];
    const request = call[1] as Request;
    expect(request.headers.get("X-Producer-Id")).toBeNull();
    expect(request.headers.get("X-Producer-Epoch")).toBeNull();
    expect(request.headers.get("X-Producer-Seq")).toBeNull();

    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it("tracks latency in metrics", async () => {
    const payload = createPayload("test");
    const messageBody: FanoutQueueMessage = {
      projectId: "test-project",
      streamId: "test-stream",
      estuaryIds: ["estuary-1"],
      payload: bufferToBase64(payload),
      contentType: "text/plain",
    };

    const message = createMockMessage(messageBody);
    const batch = createMockBatch([message]);

    const streamStubs = new Map([
      ["test-project/estuary-1", createMockStreamStub(new Response("", { status: 200 }))],
    ]);

    const mockEnv = createMockEnv(streamStubs);

    await handleFanoutQueue(batch, mockEnv);

    // Verify metrics include latency (should be a positive number)
    const metricsCall = (mockEnv.METRICS!.writeDataPoint as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const latencyMs = metricsCall.doubles[3];
    expect(latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof latencyMs).toBe("number");
  });

  it("processes large batch with many estuaries", async () => {
    const payload = createPayload("test");
    const estuaryIds = Array.from({ length: 100 }, (_, i) => `estuary-${i}`);

    const messageBody: FanoutQueueMessage = {
      projectId: "test-project",
      streamId: "test-stream",
      estuaryIds,
      payload: bufferToBase64(payload),
      contentType: "text/plain",
    };

    const message = createMockMessage(messageBody);
    const batch = createMockBatch([message]);

    // Create stubs for all estuaries
    const streamStubs = new Map(
      estuaryIds.map((id) => [
        `test-project/${id}`,
        createMockStreamStub(new Response("", { status: 200 })),
      ]),
    );

    const mockEnv = createMockEnv(streamStubs);

    await handleFanoutQueue(batch, mockEnv);

    // All should succeed
    expect(message.ack).toHaveBeenCalledTimes(1);

    // Verify metrics show all 100 successes
    expect(mockEnv.METRICS?.writeDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        doubles: expect.arrayContaining([100, 100, 0, expect.any(Number)]),
      }),
    );
  });

  it("handles undefined METRICS binding gracefully", async () => {
    const payload = createPayload("test");
    const messageBody: FanoutQueueMessage = {
      projectId: "test-project",
      streamId: "test-stream",
      estuaryIds: ["estuary-1"],
      payload: bufferToBase64(payload),
      contentType: "text/plain",
    };

    const message = createMockMessage(messageBody);
    const batch = createMockBatch([message]);

    const streamStubs = new Map([
      ["test-project/estuary-1", createMockStreamStub(new Response("", { status: 200 }))],
    ]);

    const mockEnv = createMockEnv(streamStubs);
    // Set METRICS to undefined
    mockEnv.METRICS = undefined;

    // Should not throw when METRICS is undefined
    await expect(handleFanoutQueue(batch, mockEnv)).resolves.toBeUndefined();

    expect(message.ack).toHaveBeenCalledTimes(1);
  });
});
