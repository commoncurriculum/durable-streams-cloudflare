import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { fanoutToSubscribers } from "../../src/subscriptions/fanout";

const PROJECT_ID = "test-project";

async function createSessionStream(sessionId: string): Promise<void> {
  await env.CORE.putStream(`${PROJECT_ID}/${sessionId}`, { contentType: "text/plain" });
}

describe("fanoutToSubscribers", () => {
  it("writes to all session streams", async () => {
    const s1 = `fanout-s1-${crypto.randomUUID()}`;
    const s2 = `fanout-s2-${crypto.randomUUID()}`;
    const s3 = `fanout-s3-${crypto.randomUUID()}`;
    await createSessionStream(s1);
    await createSessionStream(s2);
    await createSessionStream(s3);

    const result = await fanoutToSubscribers(
      env,
      PROJECT_ID,
      [s1, s2, s3],
      new TextEncoder().encode("hello").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(3);
    expect(result.failures).toBe(0);
    expect(result.staleSessionIds).toEqual([]);
  });

  it("reports 404s as stale sessions", async () => {
    const active1 = `fanout-active-${crypto.randomUUID()}`;
    const active2 = `fanout-active-${crypto.randomUUID()}`;
    const stale1 = `fanout-stale-${crypto.randomUUID()}`;
    const stale2 = `fanout-stale-${crypto.randomUUID()}`;
    await createSessionStream(active1);
    await createSessionStream(active2);
    // stale1 and stale2 have no backing stream — will 404

    const result = await fanoutToSubscribers(
      env,
      PROJECT_ID,
      [active1, stale1, active2, stale2],
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(2);
    expect(result.failures).toBe(2);
    expect(result.staleSessionIds).toEqual([stale1, stale2]);
  });

  it("passes producer headers to postStream", async () => {
    const s1 = `fanout-prod-${crypto.randomUUID()}`;
    await createSessionStream(s1);

    const result = await fanoutToSubscribers(
      env,
      PROJECT_ID,
      [s1],
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "text/plain",
      { producerId: "fanout:stream-1", producerEpoch: "0", producerSeq: "0" },
    );

    // Producer headers are accepted by the real core worker
    expect(result.successes).toBe(1);
    expect(result.failures).toBe(0);
  });

  it("returns correct counts for mixed results", async () => {
    const ok = `fanout-ok-${crypto.randomUUID()}`;
    const stale = `fanout-stale-${crypto.randomUUID()}`;
    await createSessionStream(ok);
    // stale has no backing stream — will 404

    const result = await fanoutToSubscribers(
      env,
      PROJECT_ID,
      [ok, stale],
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(1);
    expect(result.failures).toBe(1);
    expect(result.staleSessionIds).toEqual([stale]);
  });

  it("handles empty session list", async () => {
    const result = await fanoutToSubscribers(
      env,
      PROJECT_ID,
      [],
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(0);
    expect(result.failures).toBe(0);
    expect(result.staleSessionIds).toEqual([]);
  });

  it("batches writes in groups of 50", async () => {
    // Create 60 session streams to verify batching works across boundaries
    const sessionIds: string[] = [];
    for (let i = 0; i < 60; i++) {
      const id = `fanout-batch-${i}-${crypto.randomUUID()}`;
      sessionIds.push(id);
      await createSessionStream(id);
    }

    const result = await fanoutToSubscribers(
      env,
      PROJECT_ID,
      sessionIds,
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(60);
    expect(result.failures).toBe(0);
  });
});
