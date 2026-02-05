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
  type ReconcileResponse,
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
  // Note: These tests verify the cleanup-related functionality that can be
  // tested without waiting for actual TTL expiry. Full TTL expiry tests would
  // require either very short TTLs or mocking, which is covered in unit tests.

  it("touched sessions are preserved during cleanup checks", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    await subs.subscribe(sessionId, streamId);

    // Touch to ensure activity
    await subs.touchSession(sessionId);

    // Run reconcile (no cleanup) - session should be valid
    const reconcileRes = await subs.reconcile(false);
    expect(reconcileRes.status).toBe(200);

    const reconcile = (await reconcileRes.json()) as ReconcileResponse;
    expect(reconcile.orphanedSessionIds).not.toContain(sessionId);
  });

  it("session streams are accessible after subscription", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    await subs.subscribe(sessionId, streamId);

    // Session stream should exist in core
    const coreRes = await core.getStreamHead(`session:${sessionId}`);
    expect(coreRes.ok).toBe(true);

    // Session should be valid according to reconcile
    const reconcileRes = await subs.reconcile(false);
    const reconcile = (await reconcileRes.json()) as ReconcileResponse;
    expect(reconcile.validSessions).toBeGreaterThanOrEqual(1);
  });

  it("reconcile identifies orphaned D1 records", async () => {
    const sessionId = uniqueSessionId("orphan");
    const streamId = uniqueStreamId();

    // Create subscription (creates both D1 record and core stream)
    await subs.subscribe(sessionId, streamId);

    // Manually delete the core stream to create orphan
    await core.deleteStream(`session:${sessionId}`);

    // Allow deletion to propagate
    await delay(100);

    // Reconcile should identify this as orphaned
    const reconcileRes = await subs.reconcile(false);
    expect(reconcileRes.status).toBe(200);

    const reconcile = (await reconcileRes.json()) as ReconcileResponse;
    expect(reconcile.orphanedSessionIds).toContain(sessionId);
    expect(reconcile.orphanedInD1).toBeGreaterThanOrEqual(1);
  });

  it("reconcile cleanup removes orphaned records", async () => {
    const sessionId = uniqueSessionId("cleanup");
    const streamId = uniqueStreamId();

    // Create subscription
    await subs.subscribe(sessionId, streamId);

    // Delete core stream to create orphan
    await core.deleteStream(`session:${sessionId}`);
    await delay(100);

    // Reconcile with cleanup
    const reconcileRes = await subs.reconcile(true);
    expect(reconcileRes.status).toBe(200);

    const reconcile = (await reconcileRes.json()) as ReconcileResponse;
    expect(reconcile.cleaned).toBeGreaterThanOrEqual(1);

    // Session should now be gone from D1
    const sessionRes = await subs.getSession(sessionId);
    expect(sessionRes.status).toBe(404);
  });

  it("delete session removes session streams from core", async () => {
    const sessionId = uniqueSessionId();
    const streamId = uniqueStreamId();

    // Create subscription
    await subs.subscribe(sessionId, streamId);

    // Verify stream exists
    const beforeRes = await core.getStreamHead(`session:${sessionId}`);
    expect(beforeRes.ok).toBe(true);

    // Delete session
    await subs.deleteSession(sessionId);

    // Verify stream is deleted
    const afterRes = await core.getStreamHead(`session:${sessionId}`);
    expect(afterRes.status).toBe(404);
  });

  it("multiple subscriptions are cleaned up with session", async () => {
    const sessionId = uniqueSessionId();
    const streams = Array.from({ length: 3 }, (_, i) => uniqueStreamId(`clean-${i}`));

    // Create source streams and subscribe
    for (const streamId of streams) {
      await core.createStream(streamId);
      await subs.subscribe(sessionId, streamId);
    }

    // Verify subscriptions
    const beforeRes = await subs.getSession(sessionId);
    const before = (await beforeRes.json()) as SessionResponse;
    expect(before.subscriptions).toHaveLength(3);

    // Delete session
    await subs.deleteSession(sessionId);

    // All subscriptions should be gone
    const afterRes = await subs.getSession(sessionId);
    expect(afterRes.status).toBe(404);
  });
});
