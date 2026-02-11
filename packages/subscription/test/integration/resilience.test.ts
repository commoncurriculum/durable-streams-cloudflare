import { describe, it, expect, beforeAll } from "vitest";
import {
  createSubscriptionsClient,
  createCoreClient,
  uniqueEstuaryId,
  uniqueStreamId,
  waitFor,
  type SubscriptionsClient,
  type CoreClient,
  type EstuaryResponse,
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
    it("core estuary streams stay in sync after normal operations", async () => {
      const estuaryId = uniqueEstuaryId();
      const streamId = uniqueStreamId();

      // Create source stream and subscribe
      await core.createStream(streamId);
      await subs.subscribe(estuaryId, streamId);

      // Verify estuary stream exists
      const estuaryRes = await subs.getEstuary(estuaryId);
      expect(estuaryRes.status).toBe(200);

      const coreRes = await core.getStreamHead(estuaryId);
      expect(coreRes.ok).toBe(true);

      // Touch estuary
      await subs.touchEstuary(estuaryId);

      // Both should still be valid
      const estuaryAfter = await subs.getEstuary(estuaryId);
      expect(estuaryAfter.status).toBe(200);

      const coreAfter = await core.getStreamHead(estuaryId);
      expect(coreAfter.ok).toBe(true);

      // Delete
      await subs.deleteEstuary(estuaryId);

      // Both should be gone
      const estuaryGone = await subs.getEstuary(estuaryId);
      expect(estuaryGone.status).toBe(404);

      const coreGone = await core.getStreamHead(estuaryId);
      expect(coreGone.status).toBe(404);
    });
  });

  describe("multiple operations", () => {
    it("handles rapid subscribe/unsubscribe cycles", async () => {
      const estuaryId = uniqueEstuaryId();
      const streams = Array.from({ length: 5 }, (_, i) => uniqueStreamId(`rapid-${i}`));

      // Create all streams
      for (const streamId of streams) {
        await core.createStream(streamId);
      }

      // Rapidly subscribe to all
      for (const streamId of streams) {
        await subs.subscribe(estuaryId, streamId);
      }

      // Estuary should exist
      const estuaryRes = await subs.getEstuary(estuaryId);
      expect(estuaryRes.status).toBe(200);

      // Rapidly unsubscribe from all
      for (const streamId of streams) {
        await subs.unsubscribe(estuaryId, streamId);
      }

      // Estuary should still exist (unsubscribe doesn't delete estuary)
      const afterUnsubRes = await subs.getEstuary(estuaryId);
      expect(afterUnsubRes.status).toBe(200);
    });

    it("handles concurrent publishes to same stream", async () => {
      const estuaryId = uniqueEstuaryId();
      const streamId = uniqueStreamId();

      await core.createStream(streamId);
      await subs.subscribe(estuaryId, streamId);

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
        const content = await core.readStreamText(estuaryId);
        for (let i = 0; i < 10; i++) {
          expect(content).toContain(`"concurrent":${i}`);
        }
      });
    });

    it("handles multiple estuaries subscribing to same stream", async () => {
      const streamId = uniqueStreamId();
      const estuaries = Array.from({ length: 20 }, () => uniqueEstuaryId());

      await core.createStream(streamId);

      // Subscribe all estuaries
      const subscribes = estuaries.map((estuaryId) =>
        subs.subscribe(estuaryId, streamId),
      );
      await Promise.all(subscribes);

      // Publish a message
      const pubRes = await subs.publish(streamId, JSON.stringify({ multi: "test" }));
      expect(pubRes.ok).toBe(true);
      expect(pubRes.headers.get("Stream-Fanout-Count")).toBe("20");

      // Wait for all estuaries to receive
      await waitFor(async () => {
        for (const estuaryId of estuaries) {
          const content = await core.readStreamText(estuaryId);
          expect(content).toContain("multi");
        }
      });
    });

    it("subscriptions persist across operations", async () => {
      const estuaryId = uniqueEstuaryId();
      const stream1 = uniqueStreamId("persist-1");
      const stream2 = uniqueStreamId("persist-2");

      await core.createStream(stream1);
      await core.createStream(stream2);

      // Subscribe to first stream
      await subs.subscribe(estuaryId, stream1);

      // Publish and wait for fanout
      await subs.publish(stream1, JSON.stringify({ msg: 1 }));
      await waitFor(async () => {
        const content = await core.readStreamText(estuaryId);
        expect(content).toContain('"msg":1');
      });

      await subs.touchEstuary(estuaryId);

      // Subscribe to second stream
      await subs.subscribe(estuaryId, stream2);

      // Publish to second stream and wait for fanout
      await subs.publish(stream2, JSON.stringify({ msg: 2 }));
      await waitFor(async () => {
        const content = await core.readStreamText(estuaryId);
        expect(content).toContain('"msg":2');
      });

      // Estuary should still exist
      const estuaryRes = await subs.getEstuary(estuaryId);
      expect(estuaryRes.status).toBe(200);
    });

    it("estuaries persist across operations", async () => {
      const estuaryId = uniqueEstuaryId();
      const streamId = uniqueStreamId();

      // Create source stream and subscribe
      await core.createStream(streamId);
      await subs.subscribe(estuaryId, streamId);

      // Verify initial state
      const initialRes = await subs.getEstuary(estuaryId);
      expect(initialRes.status).toBe(200);

      // Do various operations
      await subs.touchEstuary(estuaryId);
      await subs.unsubscribe(estuaryId, streamId);
      await subs.subscribe(estuaryId, streamId);

      // Estuary should still exist
      const finalRes = await subs.getEstuary(estuaryId);
      expect(finalRes.status).toBe(200);

      const final = (await finalRes.json()) as EstuaryResponse;
      expect(final.estuaryId).toBe(estuaryId);
    });
  });

  describe("error recovery", () => {
    it("publishes to non-existent stream returns error", async () => {
      const streamId = uniqueStreamId("nonexistent");

      // Stream doesn't exist
      const res = await subs.publish(streamId, JSON.stringify({ test: true }));
      expect(res.status).toBe(404);
    });

    it("get non-existent estuary returns 404", async () => {
      const estuaryId = uniqueEstuaryId();

      const res = await subs.getEstuary(estuaryId);
      expect(res.status).toBe(404);
    });

    it("touch creates estuary if it doesn't exist", async () => {
      const estuaryId = uniqueEstuaryId();

      // Touch uses POST which creates the estuary if it doesn't exist
      const res = await subs.touchEstuary(estuaryId);
      expect(res.status).toBe(200);

      // Estuary should now exist
      const estuaryRes = await subs.getEstuary(estuaryId);
      expect(estuaryRes.status).toBe(200);
    });

    it("delete non-existent estuary succeeds (idempotent)", async () => {
      const estuaryId = uniqueEstuaryId();

      // Delete should be idempotent
      const res = await subs.deleteEstuary(estuaryId);
      // The response should succeed even if estuary doesn't exist
      expect(res.ok).toBe(true);
    });

    it("unsubscribe from non-existent subscription succeeds (idempotent)", async () => {
      const estuaryId = uniqueEstuaryId();
      const streamId = uniqueStreamId();

      // Create estuary but don't subscribe to the target stream
      const otherStream = uniqueStreamId("other");
      await core.createStream(otherStream);
      await subs.subscribe(estuaryId, otherStream);

      // Unsubscribe from a stream we're not subscribed to
      const res = await subs.unsubscribe(estuaryId, streamId);
      expect(res.ok).toBe(true);
    });
  });
});
