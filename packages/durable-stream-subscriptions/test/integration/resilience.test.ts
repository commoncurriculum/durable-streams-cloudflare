import { describe, it, expect, beforeAll } from "vitest";
import {
  createSubscriptionsClient,
  createCoreClient,
  uniqueSessionId,
  uniqueStreamId,
  delay,
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
    it("D1 and core stay in sync after normal operations", async () => {
      const sessionId = uniqueSessionId();
      const streamId = uniqueStreamId();

      // Subscribe
      await subs.subscribe(sessionId, streamId);

      // Verify both have the data
      const d1Res = await subs.getSession(sessionId);
      expect(d1Res.status).toBe(200);

      const coreRes = await core.getStreamHead(`session:${sessionId}`);
      expect(coreRes.ok).toBe(true);

      // Touch session
      await subs.touchSession(sessionId);

      // Both should still be valid
      const d1After = await subs.getSession(sessionId);
      expect(d1After.status).toBe(200);

      const coreAfter = await core.getStreamHead(`session:${sessionId}`);
      expect(coreAfter.ok).toBe(true);

      // Delete
      await subs.deleteSession(sessionId);

      // Both should be gone
      const d1Gone = await subs.getSession(sessionId);
      expect(d1Gone.status).toBe(404);

      const coreGone = await core.getStreamHead(`session:${sessionId}`);
      expect(coreGone.status).toBe(404);
    });

    it("reconcile can fix D1/core inconsistencies", async () => {
      const sessionId = uniqueSessionId("inconsistent");
      const streamId = uniqueStreamId();

      // Create subscription
      await subs.subscribe(sessionId, streamId);

      // Directly delete from core (creating inconsistency)
      await core.deleteStream(`session:${sessionId}`);
      await delay(100);

      // D1 thinks session exists but core doesn't
      const d1Res = await subs.getSession(sessionId);
      expect(d1Res.status).toBe(200);

      const coreRes = await core.getStreamHead(`session:${sessionId}`);
      expect(coreRes.status).toBe(404);

      // Run reconcile with cleanup to fix
      await subs.reconcile(true);

      // D1 should now be cleaned up
      const d1After = await subs.getSession(sessionId);
      expect(d1After.status).toBe(404);
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

      // Verify all subscribed
      let sessionRes = await subs.getSession(sessionId);
      let session = (await sessionRes.json()) as SessionResponse;
      expect(session.subscriptions).toHaveLength(5);

      // Rapidly unsubscribe from all
      for (const streamId of streams) {
        await subs.unsubscribe(sessionId, streamId);
      }

      // Verify all unsubscribed
      sessionRes = await subs.getSession(sessionId);
      session = (await sessionRes.json()) as SessionResponse;
      expect(session.subscriptions).toHaveLength(0);
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

      await delay(500);

      // Session stream should have all messages
      const content = await core.readStreamText(`session:${sessionId}`);
      for (let i = 0; i < 10; i++) {
        expect(content).toContain(`"concurrent":${i}`);
      }
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
      expect(pubRes.headers.get("X-Fanout-Count")).toBe("20");

      await delay(500);

      // All sessions should have received the message
      for (const sessionId of sessions) {
        const content = await core.readStreamText(`session:${sessionId}`);
        expect(content).toContain("multi");
      }
    });

    it("subscriptions persist across operations", async () => {
      const sessionId = uniqueSessionId();
      const stream1 = uniqueStreamId("persist-1");
      const stream2 = uniqueStreamId("persist-2");

      await core.createStream(stream1);
      await core.createStream(stream2);

      // Subscribe to first stream
      await subs.subscribe(sessionId, stream1);

      // Do some operations
      await subs.publish(stream1, JSON.stringify({ msg: 1 }));
      await delay(50);
      await subs.touchSession(sessionId);
      await delay(50);

      // Subscribe to second stream
      await subs.subscribe(sessionId, stream2);

      // Do more operations
      await subs.publish(stream2, JSON.stringify({ msg: 2 }));
      await delay(50);

      // Verify both subscriptions still exist
      const sessionRes = await subs.getSession(sessionId);
      const session = (await sessionRes.json()) as SessionResponse;
      expect(session.subscriptions).toHaveLength(2);

      const streamIds = session.subscriptions.map((s) => s.streamId);
      expect(streamIds).toContain(stream1);
      expect(streamIds).toContain(stream2);
    });

    it("sessions persist across operations", async () => {
      const sessionId = uniqueSessionId();
      const streamId = uniqueStreamId();

      // Create and subscribe
      await subs.subscribe(sessionId, streamId);

      // Get initial state
      const initialRes = await subs.getSession(sessionId);
      const initial = (await initialRes.json()) as SessionResponse;
      const initialLastActive = initial.lastActiveAt;

      // Do various operations
      await delay(100);
      await subs.touchSession(sessionId);

      await delay(100);
      await subs.unsubscribe(sessionId, streamId);

      await delay(100);
      await subs.subscribe(sessionId, streamId);

      // Session should still exist with updated lastActiveAt
      const finalRes = await subs.getSession(sessionId);
      const final = (await finalRes.json()) as SessionResponse;

      expect(final.sessionId).toBe(sessionId);
      expect(final.lastActiveAt).toBeGreaterThan(initialLastActive);
      expect(final.subscriptions).toHaveLength(1);
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

    it("touch non-existent session returns 404", async () => {
      const sessionId = uniqueSessionId("phantom");

      const res = await subs.touchSession(sessionId);
      expect(res.status).toBe(404);
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

      // Create session but don't subscribe
      await subs.subscribe(sessionId, uniqueStreamId("other"));

      // Unsubscribe from a stream we're not subscribed to
      const res = await subs.unsubscribe(sessionId, streamId);
      expect(res.ok).toBe(true);
    });
  });
});
