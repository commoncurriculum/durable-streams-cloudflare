import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

const PROJECT_ID = "test-project";

describe("SessionDO alarm cleanup", () => {
  it("alarm removes subscriptions from SubscriptionDOs and deletes session stream", async () => {
    const sessionId = crypto.randomUUID();
    const streamA = `stream-${crypto.randomUUID()}`;
    const streamB = `stream-${crypto.randomUUID()}`;

    // Set up real data: session stream + source streams
    await env.CORE.putStream(`${PROJECT_ID}/${sessionId}`, { contentType: "application/octet-stream" });
    await env.CORE.putStream(`${PROJECT_ID}/${streamA}`, { contentType: "application/json" });
    await env.CORE.putStream(`${PROJECT_ID}/${streamB}`, { contentType: "application/json" });

    // Add subscriptions to SessionDO and set expiry
    const sessionDoKey = `${PROJECT_ID}/${sessionId}`;
    const sessionStub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionDoKey));
    await sessionStub.addSubscription(streamA);
    await sessionStub.addSubscription(streamB);
    await sessionStub.setExpiry(PROJECT_ID, sessionId, 1); // 1 second TTL

    // Add subscriber to SubscriptionDOs
    const subStubA = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(`${PROJECT_ID}/${streamA}`));
    await subStubA.addSubscriber(sessionId);
    const subStubB = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(`${PROJECT_ID}/${streamB}`));
    await subStubB.addSubscriber(sessionId);

    // Trigger the alarm directly via runInDurableObject
    await runInDurableObject(sessionStub, async (instance) => {
      await instance.alarm!();
    });

    // Verify session stream was deleted
    const headResult = await env.CORE.headStream(`${PROJECT_ID}/${sessionId}`);
    expect(headResult.ok).toBe(false);

    // Verify subscribers were removed from SubscriptionDOs
    const subsA = await subStubA.getSubscribers(`${PROJECT_ID}/${streamA}`);
    expect(subsA.count).toBe(0);
    const subsB = await subStubB.getSubscribers(`${PROJECT_ID}/${streamB}`);
    expect(subsB.count).toBe(0);

    // Verify session's own state was cleaned up
    const subs = await sessionStub.getSubscriptions();
    expect(subs).toEqual([]);
  });

  it("alarm handles missing session info gracefully", async () => {
    // Create a SessionDO without calling setExpiry — alarm should be a no-op
    const sessionDoKey = `${PROJECT_ID}/${crypto.randomUUID()}`;
    const sessionStub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionDoKey));

    await runInDurableObject(sessionStub, async (instance) => {
      await instance.alarm!();
    });
    // No crash = success
  });

  it("alarm handles already-deleted session stream (404) gracefully", async () => {
    const sessionId = crypto.randomUUID();

    // SessionDO has info but no real session stream exists in core
    const sessionDoKey = `${PROJECT_ID}/${sessionId}`;
    const sessionStub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionDoKey));
    await sessionStub.setExpiry(PROJECT_ID, sessionId, 1);

    await runInDurableObject(sessionStub, async (instance) => {
      await instance.alarm!();
    });
    // No crash = success (404 is handled gracefully)
  });

  it("setExpiry resets alarm on touch", async () => {
    const sessionId = crypto.randomUUID();
    const sessionDoKey = `${PROJECT_ID}/${sessionId}`;
    const sessionStub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionDoKey));

    // Set expiry with 1 second TTL
    await sessionStub.setExpiry(PROJECT_ID, sessionId, 1);

    // Reset expiry with 10 second TTL (simulates touch)
    await sessionStub.setExpiry(PROJECT_ID, sessionId, 10);

    // Verify alarm was set (we can check via runInDurableObject)
    const alarm = await runInDurableObject(sessionStub, async (instance) => {
      return (instance as unknown as { ctx: DurableObjectState }).ctx.storage.getAlarm();
    });
    expect(alarm).not.toBeNull();
    // Alarm should be ~10s in the future, not ~1s
    expect(alarm!).toBeGreaterThan(Date.now() + 5000);
  });

  it("subscribe sets alarm on SessionDO", async () => {
    const sessionId = crypto.randomUUID();
    const streamId = `stream-${crypto.randomUUID()}`;

    // Create source stream
    await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

    const { subscribe } = await import("../src/subscriptions/subscribe");
    await subscribe(env as never, PROJECT_ID, streamId, sessionId);

    // Verify alarm was set on the SessionDO
    const sessionDoKey = `${PROJECT_ID}/${sessionId}`;
    const sessionStub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionDoKey));
    const alarm = await runInDurableObject(sessionStub, async (instance) => {
      return (instance as unknown as { ctx: DurableObjectState }).ctx.storage.getAlarm();
    });
    expect(alarm).not.toBeNull();
  });
});
