import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFanoutToSubscribers = vi.fn();
vi.mock("../../src/subscriptions/fanout", () => ({
  fanoutToSubscribers: (...args: unknown[]) => mockFanoutToSubscribers(...args),
}));

const mockMetrics = {
  fanout: vi.fn(),
};
vi.mock("../../src/metrics", () => ({
  createMetrics: vi.fn(() => mockMetrics),
}));

import { handleFanoutQueue } from "../../src/queue/fanout-consumer";
import type { AppEnv } from "../../src/env";
import type { FanoutQueueMessage } from "../../src/subscriptions/types";

const PROJECT_ID = "test-project";

function createMockEnv() {
  const mockRemoveSubscribers = vi.fn();
  return {
    env: {
      CORE: {
        fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
      },
      SUBSCRIPTION_DO: {
        idFromName: vi.fn().mockReturnValue("do-id"),
        get: vi.fn().mockReturnValue({ removeSubscribers: mockRemoveSubscribers }),
      },
      METRICS: undefined,
    } as unknown as AppEnv,
    mockRemoveSubscribers,
  };
}

function createMessage(body: FanoutQueueMessage) {
  return {
    body,
    ack: vi.fn(),
    retry: vi.fn(),
    id: "msg-1",
    timestamp: new Date(),
    attempts: 1,
  };
}

function encodePayload(text: string): string {
  return btoa(text);
}

describe("handleFanoutQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFanoutToSubscribers.mockReset();
  });

  it("decodes base64 payload and calls fanoutToSubscribers", async () => {
    mockFanoutToSubscribers.mockResolvedValue({ successes: 2, failures: 0, staleSessionIds: [] });
    const { env } = createMockEnv();

    const msg = createMessage({
      projectId: PROJECT_ID,
      streamId: "test-stream",
      sessionIds: ["s1", "s2"],
      payload: encodePayload("hello world"),
      contentType: "text/plain",
    });

    await handleFanoutQueue(
      { messages: [msg], queue: "test-queue" } as unknown as MessageBatch<FanoutQueueMessage>,
      env,
    );

    expect(mockFanoutToSubscribers).toHaveBeenCalledWith(
      env,
      PROJECT_ID,
      ["s1", "s2"],
      expect.any(ArrayBuffer),
      "text/plain",
      undefined,
    );

    // Verify decoded payload
    const passedPayload = mockFanoutToSubscribers.mock.calls[0][3] as ArrayBuffer;
    const decoded = new TextDecoder().decode(passedPayload);
    expect(decoded).toBe("hello world");

    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("passes producer headers through", async () => {
    mockFanoutToSubscribers.mockResolvedValue({ successes: 1, failures: 0, staleSessionIds: [] });
    const { env } = createMockEnv();

    const producerHeaders = {
      "Producer-Id": "fanout:stream-1",
      "Producer-Epoch": "1",
      "Producer-Seq": "42",
    };

    const msg = createMessage({
      projectId: PROJECT_ID,
      streamId: "test-stream",
      sessionIds: ["s1"],
      payload: encodePayload("test"),
      contentType: "application/json",
      producerHeaders,
    });

    await handleFanoutQueue(
      { messages: [msg], queue: "test-queue" } as unknown as MessageBatch<FanoutQueueMessage>,
      env,
    );

    expect(mockFanoutToSubscribers).toHaveBeenCalledWith(
      env,
      PROJECT_ID,
      ["s1"],
      expect.any(ArrayBuffer),
      "application/json",
      producerHeaders,
    );
  });

  it("removes stale subscribers via DO RPC", async () => {
    mockFanoutToSubscribers.mockResolvedValue({
      successes: 1,
      failures: 1,
      staleSessionIds: ["stale-session"],
    });
    const { env, mockRemoveSubscribers } = createMockEnv();

    const msg = createMessage({
      projectId: PROJECT_ID,
      streamId: "test-stream",
      sessionIds: ["active", "stale-session"],
      payload: encodePayload("test"),
      contentType: "text/plain",
    });

    await handleFanoutQueue(
      { messages: [msg], queue: "test-queue" } as unknown as MessageBatch<FanoutQueueMessage>,
      env,
    );

    expect(mockRemoveSubscribers).toHaveBeenCalledWith(["stale-session"]);
    // Only stale (404) failures, no server errors → ack
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("retries on server errors (non-404 failures)", async () => {
    mockFanoutToSubscribers.mockResolvedValue({
      successes: 0,
      failures: 2,
      staleSessionIds: [],
    });
    const { env } = createMockEnv();

    const msg = createMessage({
      projectId: PROJECT_ID,
      streamId: "test-stream",
      sessionIds: ["s1", "s2"],
      payload: encodePayload("test"),
      contentType: "text/plain",
    });

    await handleFanoutQueue(
      { messages: [msg], queue: "test-queue" } as unknown as MessageBatch<FanoutQueueMessage>,
      env,
    );

    expect(msg.retry).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("retries and logs when fanout throws", async () => {
    mockFanoutToSubscribers.mockRejectedValue(new Error("Network error"));
    const { env } = createMockEnv();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const msg = createMessage({
      projectId: PROJECT_ID,
      streamId: "test-stream",
      sessionIds: ["s1"],
      payload: encodePayload("test"),
      contentType: "text/plain",
    });

    await handleFanoutQueue(
      { messages: [msg], queue: "test-queue" } as unknown as MessageBatch<FanoutQueueMessage>,
      env,
    );

    expect(msg.retry).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("test-stream"),
      expect.any(Error),
    );

    consoleErrorSpy.mockRestore();
  });

  it("processes multiple messages in a batch", async () => {
    mockFanoutToSubscribers.mockResolvedValue({ successes: 1, failures: 0, staleSessionIds: [] });
    const { env } = createMockEnv();

    const msg1 = createMessage({
      projectId: PROJECT_ID,
      streamId: "stream-1",
      sessionIds: ["s1"],
      payload: encodePayload("msg1"),
      contentType: "text/plain",
    });
    const msg2 = createMessage({
      projectId: PROJECT_ID,
      streamId: "stream-1",
      sessionIds: ["s2"],
      payload: encodePayload("msg2"),
      contentType: "text/plain",
    });

    await handleFanoutQueue(
      { messages: [msg1, msg2], queue: "test-queue" } as unknown as MessageBatch<FanoutQueueMessage>,
      env,
    );

    expect(mockFanoutToSubscribers).toHaveBeenCalledTimes(2);
    expect(msg1.ack).toHaveBeenCalled();
    expect(msg2.ack).toHaveBeenCalled();
  });

  it("records fanout metrics", async () => {
    mockFanoutToSubscribers.mockResolvedValue({ successes: 3, failures: 1, staleSessionIds: ["stale"] });
    const { env } = createMockEnv();

    const msg = createMessage({
      projectId: PROJECT_ID,
      streamId: "test-stream",
      sessionIds: ["s1", "s2", "s3", "stale"],
      payload: encodePayload("test"),
      contentType: "text/plain",
    });

    await handleFanoutQueue(
      { messages: [msg], queue: "test-queue" } as unknown as MessageBatch<FanoutQueueMessage>,
      env,
    );

    expect(mockMetrics.fanout).toHaveBeenCalledWith({
      streamId: "test-stream",
      subscribers: 4,
      success: 3,
      failures: 1,
      latencyMs: expect.any(Number),
    });
  });
});
