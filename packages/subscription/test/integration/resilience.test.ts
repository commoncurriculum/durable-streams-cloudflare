import { describe, it, expect, beforeAll } from "vitest";
import {
  createSubscriptionsClient,
  createCoreClient,
  uniqueSessionId,
  uniqueStreamId,
  waitFor,
  type SubscriptionsClient,
  type CoreClient,
  type SessionResponse,
} from "./helpers";

let subs: SubscriptionsClient;
let core: CoreClient;

beforeAll(() => {
  const subsUrl = process.env.INTEGRATION_TEST_SUBSCRIPTIONS_URL ?? "http://localhost:8788";
  const coreUrl = process.env.INTEGRATION_TEST_CORE_URL ?? "http://localhost:8787";

  subs = createSubscriptionsClient(subsUrl);
  core = createCoreClient(coreUrl);
});

describe("resilience", () => {
  describe("data consistency", () => {
    it("core session streams stay in sync after normal operations", async () => {
      const sessionId = uniqueSessionId();
      const streamId = uniqueStreamId();

      // Create source stream and subscribe
      await core.createStream(streamId);
      await subs.subscribe(sessionId, streamId);

      // Verify session stream exists
      const sessionRes = await subs.getSession(sessionId);
      expect(sessionRes.status).toBe(200);

      const coreRes = await core.getStreamHead(sessionId);
      expect(coreRes.ok).toBe(true);

      // Touch session
      await subs.touchSession(sessionId);

      // Both should still be valid
      const sessionAfter = await subs.getSession(sessionId);
      expect(sessionAfter.status).toBe(200);

      const coreAfter = await core.getStreamHead(sessionId);
      expect(coreAfter.ok).toBe(true);

      // Delete
      await subs.deleteSession(sessionId);

      // Both should be gone
      const sessionGone = await subs.getSession(sessionId);
      expect(sessionGone.status).toBe(404);

      const coreGone = await core.getStreamHead(sessionId);
      expect(coreGone.status).toBe(404);
    });
  });

  describe("multiple operations", () => {
    it("handles rapid subscribe/unsubscribe cycles", async () => {
      const sessionId = uniqueSessionId();
      const streams = Array.from({ length: 5 }, (_, i) => uniqueStreamId(`rapid-${i}`));

      // Create all streams
      for (const streamId of streams) {
        await core.createStream(streamId);
      }

      // Rapidly subscribe to all
      for (const streamId of streams) {
        await subs.subscribe(sessionId, streamId);
      }

      // Session should exist
      const sessionRes = await subs.getSession(sessionId);
      expect(sessionRes.status).toBe(200);

      // Rapidly unsubscribe from all
      for (const streamId of streams) {
        await subs.unsubscribe(sessionId, streamId);
      }

      // Session should still exist (unsubscribe doesn't delete session)
      const afterUnsubRes = await subs.getSession(sessionId);
      expect(afterUnsubRes.status).toBe(200);
    });

    it("handles concurrent publishes to same stream", async () => {
      const sessionId = uniqueSessionId();
      const streamId = uniqueStreamId();

      await core.createStream(streamId);
      await subs.subscribe(sessionId, streamId);

      // Send multiple concurrent publishes
      const publishes = Array.from({ length: 10 }, (_, i) =>
        subs.publish(streamId, JSON.stringify({ concurrent: i })),
      );

      const results = await Promise.all(publishes);

      // All should succeed
      for (const res of results) {
        expect(res.ok).toBe(true);
      }

      // Wait for all messages to arrive
      await waitFor(async () => {
        const content = await core.readStreamText(sessionId);
        for (let i = 0; i < 10; i++) {
          expect(content).toContain(`"concurrent":${i}`);
        }
      });
    });

    it("handles multiple sessions subscribing to same stream", async () => {
      const streamId = uniqueStreamId();
      const sessions = Array.from({ length: 20 }, () => uniqueSessionId("multi"));

      await core.createStream(streamId);

      // Subscribe all sessions
      const subscribes = sessions.map((sessionId) =>
        subs.subscribe(sessionId, streamId),
      );
      await Promise.all(subscribes);

      // Publish a message
      const pubRes = await subs.publish(streamId, JSON.stringify({ multi: "test" }));
      expect(pubRes.ok).toBe(true);
      expect(pubRes.headers.get("Stream-Fanout-Count")).toBe("20");

      // Wait for all sessions to receive
      await waitFor(async () => {
        for (const sessionId of sessions) {
          const content = await core.readStreamText(sessionId);
          expect(content).toContain("multi");
        }
      });
    });

    it("subscriptions persist across operations", async () => {
      const sessionId = uniqueSessionId();
      const stream1 = uniqueStreamId("persist-1");
      const stream2 = uniqueStreamId("persist-2");

      await core.createStream(stream1);
      await core.createStream(stream2);

      // Subscribe to first stream
      await subs.subscribe(sessionId, stream1);

      // Publish and wait for fanout
      await subs.publish(stream1, JSON.stringify({ msg: 1 }));
      await waitFor(async () => {
        const content = await core.readStreamText(sessionId);
        expect(content).toContain('"msg":1');
      });

      await subs.touchSession(sessionId);

      // Subscribe to second stream
      await subs.subscribe(sessionId, stream2);

      // Publish to second stream and wait for fanout
      await subs.publish(stream2, JSON.stringify({ msg: 2 }));
      await waitFor(async () => {
        const content = await core.readStreamText(sessionId);
        expect(content).toContain('"msg":2');
      });

      // Session should still exist
      const sessionRes = await subs.getSession(sessionId);
      expect(sessionRes.status).toBe(200);
    });

    it("sessions persist across operations", async () => {
      const sessionId = uniqueSessionId();
      const streamId = uniqueStreamId();

      // Create source stream and subscribe
      await core.createStream(streamId);
      await subs.subscribe(sessionId, streamId);

      // Verify initial state
      const initialRes = await subs.getSession(sessionId);
      expect(initialRes.status).toBe(200);

      // Do various operations
      await subs.touchSession(sessionId);
      await subs.unsubscribe(sessionId, streamId);
      await subs.subscribe(sessionId, streamId);

      // Session should still exist
      const finalRes = await subs.getSession(sessionId);
      expect(finalRes.status).toBe(200);

      const final = (await finalRes.json()) as SessionResponse;
      expect(final.sessionId).toBe(sessionId);
    });
  });

  describe("error recovery", () => {
    it("publishes to non-existent stream returns error", async () => {
      const streamId = uniqueStreamId("nonexistent");

      // Stream doesn't exist
      const res = await subs.publish(streamId, JSON.stringify({ test: true }));
      expect(res.status).toBe(404);
    });

    it("get non-existent session returns 404", async () => {
      const sessionId = uniqueSessionId("ghost");

      const res = await subs.getSession(sessionId);
      expect(res.status).toBe(404);
    });

    it("touch creates session if it doesn't exist", async () => {
      const sessionId = uniqueSessionId("phantom");

      // Touch uses PUT which creates the session if it doesn't exist
      const res = await subs.touchSession(sessionId);
      expect(res.status).toBe(200);

      // Session should now exist
      const sessionRes = await subs.getSession(sessionId);
      expect(sessionRes.status).toBe(200);
    });

    it("delete non-existent session succeeds (idempotent)", async () => {
      const sessionId = uniqueSessionId("missing");

      // Delete should be idempotent
      const res = await subs.deleteSession(sessionId);
      // The response should succeed even if session doesn't exist
      expect(res.ok).toBe(true);
    });

    it("unsubscribe from non-existent subscription succeeds (idempotent)", async () => {
      const sessionId = uniqueSessionId();
      const streamId = uniqueStreamId();

      // Create session but don't subscribe to the target stream
      const otherStream = uniqueStreamId("other");
      await core.createStream(otherStream);
      await subs.subscribe(sessionId, otherStream);

      // Unsubscribe from a stream we're not subscribed to
      const res = await subs.unsubscribe(sessionId, streamId);
      expect(res.ok).toBe(true);
    });
  });
});
