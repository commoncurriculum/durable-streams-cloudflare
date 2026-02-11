import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

const PROJECT_ID = "test-project";

describe("EstuaryDO alarm cleanup", () => {
  it("alarm removes subscriptions from SubscriptionDOs and deletes estuary stream", async () => {
    const estuaryId = crypto.randomUUID();
    const streamA = `stream-${crypto.randomUUID()}`;
    const streamB = `stream-${crypto.randomUUID()}`;

    // Set up real data: estuary stream + source streams
    await env.CORE.putStream(`${PROJECT_ID}/${estuaryId}`, { contentType: "application/octet-stream" });
    await env.CORE.putStream(`${PROJECT_ID}/${streamA}`, { contentType: "application/json" });
    await env.CORE.putStream(`${PROJECT_ID}/${streamB}`, { contentType: "application/json" });

    // Add subscriptions to EstuaryDO and set expiry
    const estuaryDoKey = `${PROJECT_ID}/${estuaryId}`;
    const estuaryStub = env.ESTUARY_DO.get(env.ESTUARY_DO.idFromName(estuaryDoKey));
    await estuaryStub.addSubscription(streamA);
    await estuaryStub.addSubscription(streamB);
    await estuaryStub.setExpiry(PROJECT_ID, estuaryId, 1); // 1 second TTL

    // Add subscriber to SubscriptionDOs
    const subStubA = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(`${PROJECT_ID}/${streamA}`));
    await subStubA.addSubscriber(estuaryId);
    const subStubB = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(`${PROJECT_ID}/${streamB}`));
    await subStubB.addSubscriber(estuaryId);

    // Trigger the alarm directly via runInDurableObject
    await runInDurableObject(estuaryStub, async (instance) => {
      await instance.alarm!();
    });

    // Verify estuary stream was deleted
    const headResult = await env.CORE.headStream(`${PROJECT_ID}/${estuaryId}`);
    expect(headResult.ok).toBe(false);

    // Verify subscribers were removed from SubscriptionDOs
    const subsA = await subStubA.getSubscribers(`${PROJECT_ID}/${streamA}`);
    expect(subsA.count).toBe(0);
    const subsB = await subStubB.getSubscribers(`${PROJECT_ID}/${streamB}`);
    expect(subsB.count).toBe(0);

    // Verify estuary's own state was cleaned up
    const subs = await estuaryStub.getSubscriptions();
    expect(subs).toEqual([]);
  });

  it("alarm handles missing estuary info gracefully", async () => {
    // Create a EstuaryDO without calling setExpiry — alarm should be a no-op
    const estuaryDoKey = `${PROJECT_ID}/${crypto.randomUUID()}`;
    const estuaryStub = env.ESTUARY_DO.get(env.ESTUARY_DO.idFromName(estuaryDoKey));

    await runInDurableObject(estuaryStub, async (instance) => {
      await instance.alarm!();
    });
    // No crash = success
  });

  it("alarm handles already-deleted estuary stream (404) gracefully", async () => {
    const estuaryId = crypto.randomUUID();

    // EstuaryDO has info but no real estuary stream exists in core
    const estuaryDoKey = `${PROJECT_ID}/${estuaryId}`;
    const estuaryStub = env.ESTUARY_DO.get(env.ESTUARY_DO.idFromName(estuaryDoKey));
    await estuaryStub.setExpiry(PROJECT_ID, estuaryId, 1);

    await runInDurableObject(estuaryStub, async (instance) => {
      await instance.alarm!();
    });
    // No crash = success (404 is handled gracefully)
  });

  it("setExpiry resets alarm on touch", async () => {
    const estuaryId = crypto.randomUUID();
    const estuaryDoKey = `${PROJECT_ID}/${estuaryId}`;
    const estuaryStub = env.ESTUARY_DO.get(env.ESTUARY_DO.idFromName(estuaryDoKey));

    // Set expiry with 1 second TTL
    await estuaryStub.setExpiry(PROJECT_ID, estuaryId, 1);

    // Reset expiry with 10 second TTL (simulates touch)
    await estuaryStub.setExpiry(PROJECT_ID, estuaryId, 10);

    // Verify alarm was set (we can check via runInDurableObject)
    const alarm = await runInDurableObject(estuaryStub, async (instance) => {
      return (instance as unknown as { ctx: DurableObjectState }).ctx.storage.getAlarm();
    });
    expect(alarm).not.toBeNull();
    // Alarm should be ~10s in the future, not ~1s
    expect(alarm!).toBeGreaterThan(Date.now() + 5000);
  });

  it("subscribe sets alarm on EstuaryDO", async () => {
    const estuaryId = crypto.randomUUID();
    const streamId = `stream-${crypto.randomUUID()}`;

    // Create source stream
    await env.CORE.putStream(`${PROJECT_ID}/${streamId}`, { contentType: "application/json" });

    const { subscribe } = await import("../src/subscriptions/subscribe");
    await subscribe(env as never, PROJECT_ID, streamId, estuaryId);

    // Verify alarm was set on the EstuaryDO
    const estuaryDoKey = `${PROJECT_ID}/${estuaryId}`;
    const estuaryStub = env.ESTUARY_DO.get(env.ESTUARY_DO.idFromName(estuaryDoKey));
    const alarm = await runInDurableObject(estuaryStub, async (instance) => {
      return (instance as unknown as { ctx: DurableObjectState }).ctx.storage.getAlarm();
    });
    expect(alarm).not.toBeNull();
  });
});
