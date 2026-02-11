import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleFanoutQueue } from "../../src/queue/fanout-consumer";
import type { AppEnv } from "../../src/env";
import type { FanoutQueueMessage } from "../../src/subscriptions/types";

const PROJECT_ID = "test-project";

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
  it("decodes base64 payload and fans out to estuary streams", async () => {
    const streamId = `stream-${crypto.randomUUID()}`;
    const s1 = crypto.randomUUID();
    const s2 = crypto.randomUUID();

    // Create estuary streams with matching content type so fanout succeeds
    await env.CORE.putStream(`${PROJECT_ID}/${s1}`, { contentType: "text/plain" });
    await env.CORE.putStream(`${PROJECT_ID}/${s2}`, { contentType: "text/plain" });

    const msg = createMessage({
      projectId: PROJECT_ID,
      streamId,
      estuaryIds: [s1, s2],
      payload: encodePayload("hello world"),
      contentType: "text/plain",
    });

    await handleFanoutQueue(
      { messages: [msg], queue: "test-queue" } as unknown as MessageBatch<FanoutQueueMessage>,
      env as unknown as AppEnv,
    );

    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("removes stale subscribers when fanout returns 404", async () => {
    const streamId = `stream-${crypto.randomUUID()}`;
    const activeEstuary = crypto.randomUUID();
    const staleEstuary = crypto.randomUUID();

    // Only create the active session stream with matching content type
    await env.CORE.putStream(`${PROJECT_ID}/${activeEstuary}`, { contentType: "text/plain" });
    // staleEstuary stream does NOT exist — will 404

    // Add both as subscribers to the DO
    const doKey = `${PROJECT_ID}/${streamId}`;
    const stub = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(doKey));
    await stub.addSubscriber(activeEstuary);
    await stub.addSubscriber(staleEstuary);

    const msg = createMessage({
      projectId: PROJECT_ID,
      streamId,
      estuaryIds: [activeEstuary, staleEstuary],
      payload: encodePayload("test"),
      contentType: "text/plain",
    });

    await handleFanoutQueue(
      { messages: [msg], queue: "test-queue" } as unknown as MessageBatch<FanoutQueueMessage>,
      env as unknown as AppEnv,
    );

    // 404 failures are stale (not server errors), so message is acked
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();

    // Verify stale subscriber was removed from the DO
    const subs = await stub.getSubscribers(streamId);
    expect(subs.count).toBe(1);
    expect(subs.subscribers[0].estuaryId).toBe(activeEstuary);
  });

  it("retries when all fanout writes fail with server errors", async () => {
    // No estuary streams exist and sessions don't exist → 404s
    // But 404s are stale, not server errors, so we need a different approach.
    // Simulate server error by using a mock CORE that returns 500.
    const mockPostStream = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const failEnv = {
      ...env,
      CORE: { ...env.CORE, postStream: mockPostStream },
    } as unknown as AppEnv;

    const msg = createMessage({
      projectId: PROJECT_ID,
      streamId: "test-stream",
      estuaryIds: ["s1", "s2"],
      payload: encodePayload("test"),
      contentType: "text/plain",
    });

    await handleFanoutQueue(
      { messages: [msg], queue: "test-queue" } as unknown as MessageBatch<FanoutQueueMessage>,
      failEnv,
    );

    expect(msg.retry).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("retries and logs when fanout throws", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Use invalid base64 to trigger a throw inside handleFanoutQueue's try block
    const msg = createMessage({
      projectId: PROJECT_ID,
      streamId: "test-stream",
      estuaryIds: ["s1"],
      payload: "!!!invalid-base64!!!",
      contentType: "text/plain",
    });

    await handleFanoutQueue(
      { messages: [msg], queue: "test-queue" } as unknown as MessageBatch<FanoutQueueMessage>,
      env as unknown as AppEnv,
    );

    expect(msg.retry).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("test-stream"),
    );

    consoleErrorSpy.mockRestore();
  });

  it("processes multiple messages in a batch", async () => {
    const s1 = crypto.randomUUID();
    const s2 = crypto.randomUUID();
    await env.CORE.putStream(`${PROJECT_ID}/${s1}`, { contentType: "text/plain" });
    await env.CORE.putStream(`${PROJECT_ID}/${s2}`, { contentType: "text/plain" });

    const msg1 = createMessage({
      projectId: PROJECT_ID,
      streamId: "stream-1",
      estuaryIds: [s1],
      payload: encodePayload("msg1"),
      contentType: "text/plain",
    });
    const msg2 = createMessage({
      projectId: PROJECT_ID,
      streamId: "stream-1",
      estuaryIds: [s2],
      payload: encodePayload("msg2"),
      contentType: "text/plain",
    });

    await handleFanoutQueue(
      { messages: [msg1, msg2], queue: "test-queue" } as unknown as MessageBatch<FanoutQueueMessage>,
      env as unknown as AppEnv,
    );

    expect(msg1.ack).toHaveBeenCalled();
    expect(msg2.ack).toHaveBeenCalled();
  });
});
