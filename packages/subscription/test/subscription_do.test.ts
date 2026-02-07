import { describe, it, expect, beforeEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

const PROJECT_ID = "test-project";

function getStub(streamId: string) {
  const id = env.SUBSCRIPTION_DO.idFromName(streamId);
  return env.SUBSCRIPTION_DO.get(id);
}

describe("SubscriptionDO", () => {
  // Each test uses a unique streamId to get an isolated DO instance
  let streamId: string;
  let stub: DurableObjectStub<import("../src/subscriptions/do").SubscriptionDO>;

  beforeEach(() => {
    streamId = `test-stream-${crypto.randomUUID()}`;
    stub = getStub(streamId);
  });

  describe("addSubscriber", () => {
    it("should add a subscriber", async () => {
      await stub.addSubscriber("session-123");

      const result = await stub.getSubscribers(streamId);
      expect(result.count).toBe(1);
      expect(result.subscribers[0].sessionId).toBe("session-123");
    });

    it("should not duplicate on re-add", async () => {
      await stub.addSubscriber("session-123");
      await stub.addSubscriber("session-123");

      const result = await stub.getSubscribers(streamId);
      expect(result.count).toBe(1);
    });
  });

  describe("removeSubscriber", () => {
    it("should remove a subscriber", async () => {
      await stub.addSubscriber("session-123");
      await stub.removeSubscriber("session-123");

      const result = await stub.getSubscribers(streamId);
      expect(result.count).toBe(0);
    });
  });

  describe("removeSubscribers", () => {
    it("should remove multiple subscribers", async () => {
      await stub.addSubscriber("s1");
      await stub.addSubscriber("s2");
      await stub.addSubscriber("s3");
      await stub.removeSubscribers(["s1", "s3"]);

      const result = await stub.getSubscribers(streamId);
      expect(result.count).toBe(1);
      expect(result.subscribers[0].sessionId).toBe("s2");
    });
  });

  describe("getSubscribers", () => {
    it("should return all subscribers", async () => {
      await stub.addSubscriber("session-1");
      await stub.addSubscriber("session-2");

      const result = await stub.getSubscribers(streamId);

      expect(result.count).toBe(2);
      expect(result.subscribers).toHaveLength(2);
      expect(result.streamId).toBe(streamId);
    });
  });

  describe("publish", () => {
    // Publish tests call the DO method which internally calls CORE.postStream twice
    // (once for source write, once per subscriber). We use runInDurableObject to call
    // publish from within the DO to avoid ArrayBuffer transfer issues across RPC.

    async function publishInDO(
      doStub: DurableObjectStub<import("../src/subscriptions/do").SubscriptionDO>,
      projectId: string,
      sid: string,
      payload: string,
      contentType: string,
      producerHeaders?: { producerId: string; producerEpoch: string; producerSeq: string },
    ) {
      return runInDurableObject(doStub, async (instance) => {
        const do_ = instance as unknown as import("../src/subscriptions/do").SubscriptionDO;
        const buf = new TextEncoder().encode(payload).buffer as ArrayBuffer;
        return do_.publish(projectId, sid, {
          payload: buf,
          contentType,
          ...producerHeaders,
        });
      });
    }

    it("should write to core and fanout to subscribers with inline mode", async () => {
      // Create source stream and session streams in core
      await env.CORE.putStream(`${PROJECT_ID}/${streamId}`);

      const sessionId1 = crypto.randomUUID();
      const sessionId2 = crypto.randomUUID();
      await env.CORE.putStream(`${PROJECT_ID}/${sessionId1}`);
      await env.CORE.putStream(`${PROJECT_ID}/${sessionId2}`);

      await stub.addSubscriber(sessionId1);
      await stub.addSubscriber(sessionId2);

      const result = await publishInDO(
        stub, PROJECT_ID, streamId,
        JSON.stringify({ message: "hello" }), "application/json",
      );

      expect(result.status).toBeGreaterThanOrEqual(200);
      expect(result.status).toBeLessThan(300);
      expect(result.fanoutCount).toBe(2);
      expect(result.fanoutSuccesses).toBe(2);
      expect(result.fanoutFailures).toBe(0);
      expect(result.fanoutMode).toBe("inline");
    });

    it("should handle publish with no subscribers", async () => {
      await env.CORE.putStream(`${PROJECT_ID}/${streamId}`);

      const result = await publishInDO(
        stub, PROJECT_ID, streamId,
        JSON.stringify({ message: "hello" }), "application/json",
      );

      expect(result.status).toBeGreaterThanOrEqual(200);
      expect(result.status).toBeLessThan(300);
      expect(result.fanoutCount).toBe(0);
      expect(result.fanoutSuccesses).toBe(0);
      expect(result.fanoutFailures).toBe(0);
      expect(result.fanoutMode).toBe("inline");
    });

    it("should forward producer headers to core", async () => {
      await env.CORE.putStream(`${PROJECT_ID}/${streamId}`);

      const result = await publishInDO(
        stub, PROJECT_ID, streamId,
        JSON.stringify({ message: "hello" }), "application/json",
        { producerId: "producer-123", producerEpoch: "1", producerSeq: "0" },
      );

      expect(result.status).toBeGreaterThanOrEqual(200);
      expect(result.status).toBeLessThan(300);
    });

    it("should return error when source stream does not exist", async () => {
      const result = await publishInDO(
        stub, PROJECT_ID, streamId,
        JSON.stringify({ message: "hello" }), "application/json",
      );

      expect(result.status).toBe(404);
      expect(result.fanoutMode).toBe("inline");
      expect(JSON.parse(result.body).error).toBe("Failed to write to stream");
    });

    it("should remove stale subscriber when fanout returns 404", async () => {
      await env.CORE.putStream(`${PROJECT_ID}/${streamId}`);

      const activeSession = crypto.randomUUID();
      const staleSession = crypto.randomUUID();

      // Only create the active session stream
      await env.CORE.putStream(`${PROJECT_ID}/${activeSession}`);

      await stub.addSubscriber(activeSession);
      await stub.addSubscriber(staleSession);

      const before = await stub.getSubscribers(streamId);
      expect(before.count).toBe(2);

      const result = await publishInDO(
        stub, PROJECT_ID, streamId,
        JSON.stringify({ message: "hello" }), "application/json",
      );

      expect(result.status).toBeGreaterThanOrEqual(200);
      expect(result.status).toBeLessThan(300);
      expect(result.fanoutSuccesses).toBe(1);
      expect(result.fanoutFailures).toBe(1);
      expect(result.fanoutMode).toBe("inline");

      // Verify stale subscriber was removed
      const after = await stub.getSubscribers(streamId);
      expect(after.count).toBe(1);
      expect(after.subscribers[0].sessionId).toBe(activeSession);
    });

    it("should set nextOffset from core write", async () => {
      await env.CORE.putStream(`${PROJECT_ID}/${streamId}`);

      const result = await publishInDO(
        stub, PROJECT_ID, streamId,
        JSON.stringify({ message: "hello" }), "application/json",
      );

      expect(result.status).toBeGreaterThanOrEqual(200);
      expect(result.status).toBeLessThan(300);
      expect(result.nextOffset).not.toBeNull();
    });
  });

});
