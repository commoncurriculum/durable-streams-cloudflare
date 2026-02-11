import { describe, it, expect, beforeAll } from "vitest";
import {
  createSubscriptionsClient,
  createCoreClient,
  uniqueEstuaryId,
  uniqueStreamId,
  waitFor,
  PROJECT_ID,
  type SubscriptionsClient,
  type CoreClient,
  type SubscribeResponse,
  type EstuaryResponse,
  type TouchResponse,
} from "./helpers";

let subs: SubscriptionsClient;
let core: CoreClient;

beforeAll(() => {
  const subsUrl = process.env.INTEGRATION_TEST_SUBSCRIPTIONS_URL ?? "http://localhost:8788";
  const coreUrl = process.env.INTEGRATION_TEST_CORE_URL ?? "http://localhost:8787";

  subs = createSubscriptionsClient(subsUrl);
  core = createCoreClient(coreUrl);
});

describe("subscription flow", () => {
  it("creates estuary stream in core when subscribing", async () => {
    const estuaryId = uniqueEstuaryId();
    const streamId = uniqueStreamId();

    // Create source stream first (subscribe looks up its content type)
    await core.createStream(streamId);

    // Subscribe creates estuary stream
    const res = await subs.subscribe(estuaryId, streamId);
    expect(res.status).toBe(200);

    const body = (await res.json()) as SubscribeResponse;
    expect(body.isNewEstuary).toBe(true);
    expect(body.estuaryStreamPath).toBe(`/v1/stream/${PROJECT_ID}/${estuaryId}`);

    // Verify estuary stream exists in core
    const coreRes = await core.getStreamHead(estuaryId);
    expect(coreRes.ok).toBe(true);
  });

  it("get estuary returns estuary info", async () => {
    const estuaryId = uniqueEstuaryId();
    const streamId = uniqueStreamId();

    await core.createStream(streamId);
    await subs.subscribe(estuaryId, streamId);

    // Get estuary info
    const estuaryRes = await subs.getEstuary(estuaryId);
    expect(estuaryRes.status).toBe(200);

    const estuary = (await estuaryRes.json()) as EstuaryResponse;
    expect(estuary.estuaryId).toBe(estuaryId);
    expect(estuary.estuaryStreamPath).toBe(`/v1/stream/${PROJECT_ID}/${estuaryId}`);
  });

  it("estuary stream receives fanout messages", async () => {
    const estuaryId = uniqueEstuaryId();
    const streamId = uniqueStreamId();

    // Create source stream first
    await core.createStream(streamId);

    // Subscribe estuary to stream
    await subs.subscribe(estuaryId, streamId);

    // Publish to stream
    const payload = JSON.stringify({ message: "hello world" });
    const pubRes = await subs.publish(streamId, payload);
    expect(pubRes.status).toBe(204);

    // Wait for fanout
    await waitFor(async () => {
      const content = await core.readStreamText(estuaryId);
      expect(content).toContain("hello world");
    });
  });

  it("multiple estuaries receive same fanout message", async () => {
    const estuary1 = uniqueEstuaryId();
    const estuary2 = uniqueEstuaryId();
    const estuary3 = uniqueEstuaryId();
    const streamId = uniqueStreamId();

    // Create source stream
    await core.createStream(streamId);

    // Subscribe all estuaries
    await subs.subscribe(estuary1, streamId);
    await subs.subscribe(estuary2, streamId);
    await subs.subscribe(estuary3, streamId);

    // Publish message
    const payload = JSON.stringify({ event: "broadcast" });
    const pubRes = await subs.publish(streamId, payload);
    expect(pubRes.status).toBe(204);

    // Wait for fanout to all estuaries
    await waitFor(async () => {
      const content1 = await core.readStreamText(estuary1);
      const content2 = await core.readStreamText(estuary2);
      const content3 = await core.readStreamText(estuary3);

      expect(content1).toContain("broadcast");
      expect(content2).toContain("broadcast");
      expect(content3).toContain("broadcast");
    });
  });

  it("unsubscribe stops receiving fanout messages", async () => {
    const estuaryId = uniqueEstuaryId();
    const streamId = uniqueStreamId();

    // Create stream and subscribe
    await core.createStream(streamId);
    await subs.subscribe(estuaryId, streamId);

    // Publish first message
    const pub1Res = await subs.publish(streamId, JSON.stringify({ msg: 1 }));
    expect(pub1Res.status).toBe(204);

    // Wait for first message to arrive
    await waitFor(async () => {
      const content = await core.readStreamText(estuaryId);
      expect(content).toContain('"msg":1');
    });

    // Unsubscribe
    const unsubRes = await subs.unsubscribe(estuaryId, streamId);
    expect(unsubRes.status).toBe(200);

    // Publish second message
    const pub2Res = await subs.publish(streamId, JSON.stringify({ msg: 2 }));
    expect(pub2Res.status).toBe(204);

    // Wait a short time, then verify second message NOT received
    await waitFor(async () => {
      const content = await core.readStreamText(estuaryId);
      expect(content).toContain('"msg":1');
      expect(content).not.toContain('"msg":2');
    }, { timeout: 500 });
  });
});

describe("publish flow", () => {
  it("writes message to source stream", async () => {
    const streamId = uniqueStreamId();

    // Create stream
    await core.createStream(streamId);

    // Publish via subscriptions service
    const payload = JSON.stringify({ data: "test" });
    const res = await subs.publish(streamId, payload);
    expect(res.status).toBe(204);

    // Verify message in source stream
    const content = await core.readStreamText(streamId);
    expect(content).toContain("test");
  });

  it("fans out to all subscribed estuaries", async () => {
    const estuaries = Array.from({ length: 5 }, () => uniqueEstuaryId());
    const streamId = uniqueStreamId();

    await core.createStream(streamId);

    // Subscribe all estuaries
    for (const estuary of estuaries) {
      await subs.subscribe(estuary, streamId);
    }

    // Publish
    const res = await subs.publish(streamId, JSON.stringify({ fanout: true }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Stream-Fanout-Count")).toBe("5");

    // Wait for fanout
    await waitFor(async () => {
      for (const estuary of estuaries) {
        const content = await core.readStreamText(estuary);
        expect(content).toContain("fanout");
      }
    });
  });

  it("estuary streams contain correct message content", async () => {
    const estuaryId = uniqueEstuaryId();
    const streamId = uniqueStreamId();

    await core.createStream(streamId);
    await subs.subscribe(estuaryId, streamId);

    // Send multiple messages
    await subs.publish(streamId, JSON.stringify({ seq: 1, data: "first" }));
    await subs.publish(streamId, JSON.stringify({ seq: 2, data: "second" }));
    await subs.publish(streamId, JSON.stringify({ seq: 3, data: "third" }));

    // Wait for all messages
    await waitFor(async () => {
      const content = await core.readStreamText(estuaryId);
      expect(content).toContain('"seq":1');
      expect(content).toContain('"seq":2');
      expect(content).toContain('"seq":3');
      expect(content).toContain("first");
      expect(content).toContain("second");
      expect(content).toContain("third");
    });
  });

  it("producer headers provide idempotency", async () => {
    const estuaryId = uniqueEstuaryId();
    const streamId = uniqueStreamId();

    await core.createStream(streamId);
    await subs.subscribe(estuaryId, streamId);

    // Publish with producer headers
    // Note: Producer-Seq must start at 0 for a new producer
    const payload = JSON.stringify({ unique: true });
    const headers = {
      "Content-Type": "application/json",
      "Producer-Id": "test-producer",
      "Producer-Epoch": "1",
      "Producer-Seq": "0",
    };

    const subsUrl = process.env.INTEGRATION_TEST_SUBSCRIPTIONS_URL ?? "http://localhost:8788";

    // First publish
    const res1 = await fetch(`${subsUrl}/v1/estuary/publish/${PROJECT_ID}/${streamId}`, {
      method: "POST",
      headers,
      body: payload,
    });
    expect(res1.ok).toBe(true);

    // Wait for fanout
    await waitFor(async () => {
      const content = await core.readStreamText(estuaryId);
      expect(content).toContain("unique");
    });
  });

  it("duplicate publish with same producer headers is idempotent", async () => {
    const streamId = uniqueStreamId();

    await core.createStream(streamId);

    // Note: Producer-Seq must start at 0 for a new producer
    const payload = JSON.stringify({ dedup: "test" });
    const subsUrl = process.env.INTEGRATION_TEST_SUBSCRIPTIONS_URL ?? "http://localhost:8788";
    const headers = {
      "Content-Type": "application/json",
      "Producer-Id": `dedup-producer-${streamId}`,
      "Producer-Epoch": "1",
      "Producer-Seq": "0",
    };

    // Publish twice with same producer headers
    const res1 = await fetch(`${subsUrl}/v1/estuary/publish/${PROJECT_ID}/${streamId}`, {
      method: "POST",
      headers,
      body: payload,
    });

    const res2 = await fetch(`${subsUrl}/v1/estuary/publish/${PROJECT_ID}/${streamId}`, {
      method: "POST",
      headers,
      body: payload,
    });

    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);

    // Source stream should only have one message due to deduplication
    const content = await core.readStreamText(streamId);
    const matches = content.match(/"dedup":"test"/g);
    expect(matches).toHaveLength(1);
  });
});

describe("estuary lifecycle", () => {
  it("touch returns new expiry time", async () => {
    const estuaryId = uniqueEstuaryId();
    const streamId = uniqueStreamId();

    await core.createStream(streamId);
    await subs.subscribe(estuaryId, streamId);

    // Touch estuary
    const touchRes = await subs.touchEstuary(estuaryId);
    expect(touchRes.status).toBe(200);

    const touch = (await touchRes.json()) as TouchResponse;
    expect(touch.estuaryId).toBe(estuaryId);
    expect(touch.expiresAt).toBeGreaterThan(Date.now());
  });

  it("delete estuary removes from core", async () => {
    const estuaryId = uniqueEstuaryId();
    const streamId = uniqueStreamId();

    await core.createStream(streamId);
    await subs.subscribe(estuaryId, streamId);

    // Verify exists
    const beforeCore = await core.getStreamHead(estuaryId);
    expect(beforeCore.ok).toBe(true);

    const beforeEstuary = await subs.getEstuary(estuaryId);
    expect(beforeEstuary.status).toBe(200);

    // Delete
    const delRes = await subs.deleteEstuary(estuaryId);
    expect(delRes.status).toBe(200);

    // Verify gone from core
    const afterCore = await core.getStreamHead(estuaryId);
    expect(afterCore.status).toBe(404);

    // Estuary endpoint should return 404
    const afterEstuary = await subs.getEstuary(estuaryId);
    expect(afterEstuary.status).toBe(404);
  });

  it("subscriptions work after estuary delete and recreate", async () => {
    const estuaryId = uniqueEstuaryId();
    const stream1 = uniqueStreamId("sub1");
    const stream2 = uniqueStreamId("sub2");

    await core.createStream(stream1);
    await core.createStream(stream2);

    // Subscribe
    await subs.subscribe(estuaryId, stream1);
    await subs.subscribe(estuaryId, stream2);

    // Delete estuary
    await subs.deleteEstuary(estuaryId);

    // Estuary should be gone
    const afterDelete = await subs.getEstuary(estuaryId);
    expect(afterDelete.status).toBe(404);

    // Re-subscribe creates new estuary
    const resubRes = await subs.subscribe(estuaryId, stream1);
    expect(resubRes.status).toBe(200);

    const resub = (await resubRes.json()) as SubscribeResponse;
    expect(resub.isNewEstuary).toBe(true);

    // Estuary should exist again
    const afterResub = await subs.getEstuary(estuaryId);
    expect(afterResub.status).toBe(200);
  });
});
