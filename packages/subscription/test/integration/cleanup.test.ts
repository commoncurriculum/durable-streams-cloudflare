import { describe, it, expect, beforeAll } from "vitest";
import {
  createSubscriptionsClient,
  createCoreClient,
  uniqueSessionId,
  uniqueStreamId,
  type SubscriptionsClient,
  type CoreClient,
} from "./helpers";

let subs: SubscriptionsClient;
let core: CoreClient;

beforeAll(() => {
  const subsUrl = process.env.INTEGRATION_TEST_SUBSCRIPTIONS_URL ?? "http://localhost:8788";
  const coreUrl = process.env.INTEGRATION_TEST_CORE_URL ?? "http://localhost:8787";

  subs = createSubscriptionsClient(subsUrl);
  core = createCoreClient(coreUrl);
});

describe("cleanup integration", () => {
  // Session cleanup is handled by SessionDO alarms:
  // - Each session sets a DO alarm at creation/touch time
  // - When the alarm fires, SessionDO removes subscriptions and deletes the stream
  // - SubscriptionDOs also clean up stale subscribers during fanout (404 response)

  it("session streams are accessible after subscription", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    await core.createStream(streamId);
    await subs.subscribe(sessionId, streamId);

    // Session stream should exist in core
    const coreRes = await core.getStreamHead(sessionId);
    expect(coreRes.ok).toBe(true);
  });

  it("delete session removes session streams from core", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    // Create source stream and subscription
    await core.createStream(streamId);
    await subs.subscribe(sessionId, streamId);

    // Verify stream exists
    const beforeRes = await core.getStreamHead(sessionId);
    expect(beforeRes.ok).toBe(true);

    // Delete session
    await subs.deleteSession(sessionId);

    // Verify stream is deleted
    const afterRes = await core.getStreamHead(sessionId);
    expect(afterRes.status).toBe(404);
  });

  it("multiple subscriptions work with same session", async () => {
    const sessionId = uniqueSessionId();
    const streams = Array.from({ length: 3 }, (_, i) => uniqueStreamId(`clean-${i}`));

    // Create source streams and subscribe
    for (const streamId of streams) {
      await core.createStream(streamId);
      await subs.subscribe(sessionId, streamId);
    }

    // Session should exist
    const sessionRes = await subs.getSession(sessionId);
    expect(sessionRes.status).toBe(200);

    // Delete session
    await subs.deleteSession(sessionId);

    // Session should be gone (404)
    const afterRes = await subs.getSession(sessionId);
    expect(afterRes.status).toBe(404);
  });

  it("session touch works", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    await core.createStream(streamId);
    await subs.subscribe(sessionId, streamId);

    // Touch should succeed
    const touchRes = await subs.touchSession(sessionId);
    expect(touchRes.status).toBe(200);

    // Session should still exist
    const sessionRes = await subs.getSession(sessionId);
    expect(sessionRes.status).toBe(200);
  });
});
