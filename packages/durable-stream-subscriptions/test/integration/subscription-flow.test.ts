import { describe, it, expect, beforeAll } from "vitest";
import {
  createSubscriptionsClient,
  createCoreClient,
  uniqueSessionId,
  uniqueStreamId,
  delay,
  type SubscriptionsClient,
  type CoreClient,
  type SubscribeResponse,
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

describe("subscription flow", () => {
  it("creates session stream in core when subscribing", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    // Subscribe creates session stream
    const res = await subs.subscribe(sessionId, streamId);
    expect(res.status).toBe(200);

    const body = (await res.json()) as SubscribeResponse;
    expect(body.isNewSession).toBe(true);
    expect(body.sessionStreamPath).toBe(`/v1/stream/session:${sessionId}`);

    // Verify session stream exists in core
    const coreRes = await core.getStreamHead(`session:${sessionId}`);
    expect(coreRes.ok).toBe(true);
  });

  it("persists subscription in D1", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    await subs.subscribe(sessionId, streamId);

    // Get session info to verify subscription
    const sessionRes = await subs.getSession(sessionId);
    expect(sessionRes.status).toBe(200);

    const session = (await sessionRes.json()) as SessionResponse;
    expect(session.subscriptions).toHaveLength(1);
    expect(session.subscriptions[0].streamId).toBe(streamId);
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
    expect(pubRes.status).toBe(200);

    // Give a moment for fanout
    await delay(100);

    // Read from session stream
    const content = await core.readStreamText(`session:${sessionId}`);
    expect(content).toContain("hello world");
  });

  it("multiple sessions receive same fanout message", async () => {
    const session1 = uniqueSessionId("s1");
    const session2 = uniqueSessionId("s2");
    const session3 = uniqueSessionId("s3");
    const streamId = uniqueStreamId();

    // Create source stream
    await core.createStream(streamId);

    // Subscribe all sessions
    await subs.subscribe(session1, streamId);
    await subs.subscribe(session2, streamId);
    await subs.subscribe(session3, streamId);

    // Publish message
    const payload = JSON.stringify({ event: "broadcast" });
    await subs.publish(streamId, payload);

    // Allow fanout
    await delay(200);

    // All sessions should have received the message
    const content1 = await core.readStreamText(`session:${session1}`);
    const content2 = await core.readStreamText(`session:${session2}`);
    const content3 = await core.readStreamText(`session:${session3}`);

    expect(content1).toContain("broadcast");
    expect(content2).toContain("broadcast");
    expect(content3).toContain("broadcast");
  });

  it("unsubscribe stops receiving fanout messages", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    // Create stream and subscribe
    await core.createStream(streamId);
    await subs.subscribe(sessionId, streamId);

    // Publish first message
    await subs.publish(streamId, JSON.stringify({ msg: 1 }));
    await delay(100);

    // Unsubscribe
    const unsubRes = await subs.unsubscribe(sessionId, streamId);
    expect(unsubRes.status).toBe(200);

    // Publish second message
    await subs.publish(streamId, JSON.stringify({ msg: 2 }));
    await delay(100);

    // Session stream should only have the first message
    const content = await core.readStreamText(`session:${sessionId}`);
    expect(content).toContain('"msg":1');
    expect(content).not.toContain('"msg":2');
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
    expect(res.status).toBe(200);

    // Verify message in source stream
    const content = await core.readStreamText(streamId);
    expect(content).toContain("test");
  });

  it("fans out to all subscribed sessions", async () => {
    const sessions = Array.from({ length: 5 }, (_, i) => uniqueSessionId(`fan-${i}`));
    const streamId = uniqueStreamId();

    await core.createStream(streamId);

    // Subscribe all sessions
    for (const session of sessions) {
      await subs.subscribe(session, streamId);
    }

    // Publish
    const res = await subs.publish(streamId, JSON.stringify({ fanout: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Fanout-Count")).toBe("5");

    await delay(200);

    // Verify all sessions received
    for (const session of sessions) {
      const content = await core.readStreamText(`session:${session}`);
      expect(content).toContain("fanout");
    }
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

    await delay(200);

    const content = await core.readStreamText(`session:${sessionId}`);
    expect(content).toContain('"seq":1');
    expect(content).toContain('"seq":2');
    expect(content).toContain('"seq":3');
    expect(content).toContain("first");
    expect(content).toContain("second");
    expect(content).toContain("third");
  });

  it("producer headers provide idempotency", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    await core.createStream(streamId);
    await subs.subscribe(sessionId, streamId);

    // Publish with producer headers
    const payload = JSON.stringify({ unique: true });
    const headers = {
      "Content-Type": "application/json",
      "Producer-Id": "test-producer",
      "Producer-Epoch": "1",
      "Producer-Seq": "100",
    };

    const subsUrl = process.env.INTEGRATION_TEST_SUBSCRIPTIONS_URL ?? "http://localhost:8788";

    // First publish
    const res1 = await fetch(`${subsUrl}/v1/publish/${streamId}`, {
      method: "POST",
      headers,
      body: payload,
    });
    expect(res1.ok).toBe(true);

    await delay(100);

    const content = await core.readStreamText(`session:${sessionId}`);
    expect(content).toContain("unique");
  });

  it("duplicate publish with same producer headers is idempotent", async () => {
    const streamId = uniqueStreamId();

    await core.createStream(streamId);

    const payload = JSON.stringify({ dedup: "test" });
    const subsUrl = process.env.INTEGRATION_TEST_SUBSCRIPTIONS_URL ?? "http://localhost:8788";
    const headers = {
      "Content-Type": "application/json",
      "Producer-Id": `dedup-producer-${streamId}`,
      "Producer-Epoch": "1",
      "Producer-Seq": "1",
    };

    // Publish twice with same producer headers
    const res1 = await fetch(`${subsUrl}/v1/publish/${streamId}`, {
      method: "POST",
      headers,
      body: payload,
    });

    const res2 = await fetch(`${subsUrl}/v1/publish/${streamId}`, {
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
  it("touch extends session TTL", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    await subs.subscribe(sessionId, streamId);

    const before = await subs.getSession(sessionId);
    const sessionBefore = (await before.json()) as SessionResponse;
    const expiresBefore = sessionBefore.expiresAt;

    // Wait a bit then touch
    await delay(100);
    await subs.touchSession(sessionId);

    const after = await subs.getSession(sessionId);
    const sessionAfter = (await after.json()) as SessionResponse;
    const expiresAfter = sessionAfter.expiresAt;

    // Expiry should be extended
    expect(expiresAfter).toBeGreaterThan(expiresBefore);
  });

  it("session info reflects correct expiry time", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    await subs.subscribe(sessionId, streamId);

    const res = await subs.getSession(sessionId);
    const session = (await res.json()) as SessionResponse;

    // expiresAt should be last_active_at + ttl_seconds * 1000
    const expectedExpiry = session.lastActiveAt + session.ttlSeconds * 1000;
    expect(session.expiresAt).toBe(expectedExpiry);
  });

  it("delete session removes from both core and D1", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    await subs.subscribe(sessionId, streamId);

    // Verify exists
    const beforeCore = await core.getStreamHead(`session:${sessionId}`);
    expect(beforeCore.ok).toBe(true);

    const beforeD1 = await subs.getSession(sessionId);
    expect(beforeD1.status).toBe(200);

    // Delete
    const delRes = await subs.deleteSession(sessionId);
    expect(delRes.status).toBe(200);

    // Verify gone from both
    const afterCore = await core.getStreamHead(`session:${sessionId}`);
    expect(afterCore.status).toBe(404);

    const afterD1 = await subs.getSession(sessionId);
    expect(afterD1.status).toBe(404);
  });

  it("subscriptions are deleted with session", async () => {
    const sessionId = uniqueSessionId();
    const stream1 = uniqueStreamId("sub1");
    const stream2 = uniqueStreamId("sub2");

    await core.createStream(stream1);
    await core.createStream(stream2);

    await subs.subscribe(sessionId, stream1);
    await subs.subscribe(sessionId, stream2);

    // Verify subscriptions exist
    const beforeRes = await subs.getSession(sessionId);
    const before = (await beforeRes.json()) as SessionResponse;
    expect(before.subscriptions).toHaveLength(2);

    // Delete session
    await subs.deleteSession(sessionId);

    // Session and subscriptions should be gone
    const afterRes = await subs.getSession(sessionId);
    expect(afterRes.status).toBe(404);
  });
});
