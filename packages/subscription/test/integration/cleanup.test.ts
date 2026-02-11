import { describe, it, expect, beforeAll } from "vitest";
import {
  createSubscriptionsClient,
  createCoreClient,
  uniqueEstuaryId,
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
  // Estuary cleanup is handled by EstuaryDO alarms:
  // - Each estuary sets a DO alarm at creation/touch time
  // - When the alarm fires, EstuaryDO removes subscriptions and deletes the stream
  // - SubscriptionDOs also clean up stale subscribers during fanout (404 response)

  it("estuary streams are accessible after subscription", async () => {
    const estuaryId = uniqueEstuaryId();
    const streamId = uniqueStreamId();

    await core.createStream(streamId);
    await subs.subscribe(estuaryId, streamId);

    // Estuary stream should exist in core
    const coreRes = await core.getStreamHead(estuaryId);
    expect(coreRes.ok).toBe(true);
  });

  it("delete estuary removes estuary streams from core", async () => {
    const estuaryId = uniqueEstuaryId();
    const streamId = uniqueStreamId();

    // Create source stream and subscription
    await core.createStream(streamId);
    await subs.subscribe(estuaryId, streamId);

    // Verify stream exists
    const beforeRes = await core.getStreamHead(estuaryId);
    expect(beforeRes.ok).toBe(true);

    // Delete estuary
    await subs.deleteEstuary(estuaryId);

    // Verify stream is deleted
    const afterRes = await core.getStreamHead(estuaryId);
    expect(afterRes.status).toBe(404);
  });

  it("multiple subscriptions work with same estuary", async () => {
    const estuaryId = uniqueEstuaryId();
    const streams = Array.from({ length: 3 }, (_, i) => uniqueStreamId(`clean-${i}`));

    // Create source streams and subscribe
    for (const streamId of streams) {
      await core.createStream(streamId);
      await subs.subscribe(estuaryId, streamId);
    }

    // Estuary should exist
    const estuaryRes = await subs.getEstuary(estuaryId);
    expect(estuaryRes.status).toBe(200);

    // Delete estuary
    await subs.deleteEstuary(estuaryId);

    // Estuary should be gone (404)
    const afterRes = await subs.getEstuary(estuaryId);
    expect(afterRes.status).toBe(404);
  });

  it("estuary touch works", async () => {
    const estuaryId = uniqueEstuaryId();
    const streamId = uniqueStreamId();

    await core.createStream(streamId);
    await subs.subscribe(estuaryId, streamId);

    // Touch should succeed
    const touchRes = await subs.touchEstuary(estuaryId);
    expect(touchRes.status).toBe(200);

    // Estuary should still exist
    const estuaryRes = await subs.getEstuary(estuaryId);
    expect(estuaryRes.status).toBe(200);
  });
});
