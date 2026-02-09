import { describe, it, expect, beforeAll } from "vitest";
import {
  createSubscriptionsClient,
  createCoreClient,
  uniqueSessionId,
  uniqueStreamId,
  waitFor,
  PROJECT_ID,
  type SubscriptionsClient,
  type CoreClient,
  type SubscribeResponse,
  type SessionResponse,
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
  it("creates session stream in core when subscribing", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    // Create source stream first (subscribe looks up its content type)
    await core.createStream(streamId);

    // Subscribe creates session stream
    const res = await subs.subscribe(sessionId, streamId);
    expect(res.status).toBe(200);

    const body = (await res.json()) as SubscribeResponse;
    expect(body.isNewSession).toBe(true);
    expect(body.sessionStreamPath).toBe(`/v1/${PROJECT_ID}/stream/${sessionId}`);

    // Verify session stream exists in core
    const coreRes = await core.getStreamHead(sessionId);
    expect(coreRes.ok).toBe(true);
  });

  it("get session returns session info", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    await core.createStream(streamId);
    await subs.subscribe(sessionId, streamId);

    // Get session info
    const sessionRes = await subs.getSession(sessionId);
    expect(sessionRes.status).toBe(200);

    const session = (await sessionRes.json()) as SessionResponse;
    expect(session.sessionId).toBe(sessionId);
    expect(session.sessionStreamPath).toBe(`/v1/${PROJECT_ID}/stream/${sessionId}`);
  });

  it("session stream receives fanout messages", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    // Create source stream first
    await core.createStream(streamId);

    // Subscribe session to stream
    await subs.subscribe(sessionId, streamId);

    // Publish to stream
    const payload = JSON.stringify({ message: "hello world" });
    const pubRes = await subs.publish(streamId, payload);
    expect(pubRes.status).toBe(204);

    // Wait for fanout
    await waitFor(async () => {
      const content = await core.readStreamText(sessionId);
      expect(content).toContain("hello world");
    });
  });

  it("multiple sessions receive same fanout message", async () => {
    const session1 = uniqueSessionId();
    const session2 = uniqueSessionId();
    const session3 = uniqueSessionId();
    const streamId = uniqueStreamId();

    // Create source stream
    await core.createStream(streamId);

    // Subscribe all sessions
    await subs.subscribe(session1, streamId);
    await subs.subscribe(session2, streamId);
    await subs.subscribe(session3, streamId);

    // Publish message
    const payload = JSON.stringify({ event: "broadcast" });
    const pubRes = await subs.publish(streamId, payload);
    expect(pubRes.status).toBe(204);

    // Wait for fanout to all sessions
    await waitFor(async () => {
      const content1 = await core.readStreamText(session1);
      const content2 = await core.readStreamText(session2);
      const content3 = await core.readStreamText(session3);

      expect(content1).toContain("broadcast");
      expect(content2).toContain("broadcast");
      expect(content3).toContain("broadcast");
    });
  });

  it("unsubscribe stops receiving fanout messages", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    // Create stream and subscribe
    await core.createStream(streamId);
    await subs.subscribe(sessionId, streamId);

    // Publish first message
    const pub1Res = await subs.publish(streamId, JSON.stringify({ msg: 1 }));
    expect(pub1Res.status).toBe(204);

    // Wait for first message to arrive
    await waitFor(async () => {
      const content = await core.readStreamText(sessionId);
      expect(content).toContain('"msg":1');
    });

    // Unsubscribe
    const unsubRes = await subs.unsubscribe(sessionId, streamId);
    expect(unsubRes.status).toBe(200);

    // Publish second message
    const pub2Res = await subs.publish(streamId, JSON.stringify({ msg: 2 }));
    expect(pub2Res.status).toBe(204);

    // Wait a short time, then verify second message NOT received
    await waitFor(async () => {
      const content = await core.readStreamText(sessionId);
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

  it("fans out to all subscribed sessions", async () => {
    const sessions = Array.from({ length: 5 }, () => uniqueSessionId());
    const streamId = uniqueStreamId();

    await core.createStream(streamId);

    // Subscribe all sessions
    for (const session of sessions) {
      await subs.subscribe(session, streamId);
    }

    // Publish
    const res = await subs.publish(streamId, JSON.stringify({ fanout: true }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Stream-Fanout-Count")).toBe("5");

    // Wait for fanout
    await waitFor(async () => {
      for (const session of sessions) {
        const content = await core.readStreamText(session);
        expect(content).toContain("fanout");
      }
    });
  });

  it("session streams contain correct message content", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    await core.createStream(streamId);
    await subs.subscribe(sessionId, streamId);

    // Send multiple messages
    await subs.publish(streamId, JSON.stringify({ seq: 1, data: "first" }));
    await subs.publish(streamId, JSON.stringify({ seq: 2, data: "second" }));
    await subs.publish(streamId, JSON.stringify({ seq: 3, data: "third" }));

    // Wait for all messages
    await waitFor(async () => {
      const content = await core.readStreamText(sessionId);
      expect(content).toContain('"seq":1');
      expect(content).toContain('"seq":2');
      expect(content).toContain('"seq":3');
      expect(content).toContain("first");
      expect(content).toContain("second");
      expect(content).toContain("third");
    });
  });

  it("producer headers provide idempotency", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    await core.createStream(streamId);
    await subs.subscribe(sessionId, streamId);

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
    const res1 = await fetch(`${subsUrl}/v1/${PROJECT_ID}/publish/${streamId}`, {
      method: "POST",
      headers,
      body: payload,
    });
    expect(res1.ok).toBe(true);

    // Wait for fanout
    await waitFor(async () => {
      const content = await core.readStreamText(sessionId);
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
    const res1 = await fetch(`${subsUrl}/v1/${PROJECT_ID}/publish/${streamId}`, {
      method: "POST",
      headers,
      body: payload,
    });

    const res2 = await fetch(`${subsUrl}/v1/${PROJECT_ID}/publish/${streamId}`, {
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

describe("session lifecycle", () => {
  it("touch returns new expiry time", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    await core.createStream(streamId);
    await subs.subscribe(sessionId, streamId);

    // Touch session
    const touchRes = await subs.touchSession(sessionId);
    expect(touchRes.status).toBe(200);

    const touch = (await touchRes.json()) as TouchResponse;
    expect(touch.sessionId).toBe(sessionId);
    expect(touch.expiresAt).toBeGreaterThan(Date.now());
  });

  it("delete session removes from core", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    await core.createStream(streamId);
    await subs.subscribe(sessionId, streamId);

    // Verify exists
    const beforeCore = await core.getStreamHead(sessionId);
    expect(beforeCore.ok).toBe(true);

    const beforeSession = await subs.getSession(sessionId);
    expect(beforeSession.status).toBe(200);

    // Delete
    const delRes = await subs.deleteSession(sessionId);
    expect(delRes.status).toBe(200);

    // Verify gone from core
    const afterCore = await core.getStreamHead(sessionId);
    expect(afterCore.status).toBe(404);

    // Session endpoint should return 404
    const afterSession = await subs.getSession(sessionId);
    expect(afterSession.status).toBe(404);
  });

  it("subscriptions work after session delete and recreate", async () => {
    const sessionId = uniqueSessionId();
    const stream1 = uniqueStreamId("sub1");
    const stream2 = uniqueStreamId("sub2");

    await core.createStream(stream1);
    await core.createStream(stream2);

    // Subscribe
    await subs.subscribe(sessionId, stream1);
    await subs.subscribe(sessionId, stream2);

    // Delete session
    await subs.deleteSession(sessionId);

    // Session should be gone
    const afterDelete = await subs.getSession(sessionId);
    expect(afterDelete.status).toBe(404);

    // Re-subscribe creates new session
    const resubRes = await subs.subscribe(sessionId, stream1);
    expect(resubRes.status).toBe(200);

    const resub = (await resubRes.json()) as SubscribeResponse;
    expect(resub.isNewSession).toBe(true);

    // Session should exist again
    const afterResub = await subs.getSession(sessionId);
    expect(afterResub.status).toBe(200);
  });
});
