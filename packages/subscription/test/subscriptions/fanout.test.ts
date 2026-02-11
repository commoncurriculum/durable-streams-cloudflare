import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { fanoutToSubscribers } from "../../src/subscriptions/fanout";

const PROJECT_ID = "test-project";

async function createEstuaryStream(estuaryId: string): Promise<void> {
  await env.CORE.putStream(`${PROJECT_ID}/${estuaryId}`, { contentType: "text/plain" });
}

describe("fanoutToSubscribers", () => {
  it("writes to all estuary streams", async () => {
    const s1 = `fanout-s1-${crypto.randomUUID()}`;
    const s2 = `fanout-s2-${crypto.randomUUID()}`;
    const s3 = `fanout-s3-${crypto.randomUUID()}`;
    await createEstuaryStream(s1);
    await createEstuaryStream(s2);
    await createEstuaryStream(s3);

    const result = await fanoutToSubscribers(
      env,
      PROJECT_ID,
      [s1, s2, s3],
      new TextEncoder().encode("hello").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(3);
    expect(result.failures).toBe(0);
    expect(result.staleEstuaryIds).toEqual([]);
  });

  it("reports 404s as stale estuaries", async () => {
    const active1 = `fanout-active-${crypto.randomUUID()}`;
    const active2 = `fanout-active-${crypto.randomUUID()}`;
    const stale1 = `fanout-stale-${crypto.randomUUID()}`;
    const stale2 = `fanout-stale-${crypto.randomUUID()}`;
    await createEstuaryStream(active1);
    await createEstuaryStream(active2);
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
    expect(result.staleEstuaryIds).toEqual([stale1, stale2]);
  });

  it("passes producer headers to postStream", async () => {
    const s1 = `fanout-prod-${crypto.randomUUID()}`;
    await createEstuaryStream(s1);

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
    await createEstuaryStream(ok);
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
    expect(result.staleEstuaryIds).toEqual([stale]);
  });

  it("handles empty estuary list", async () => {
    const result = await fanoutToSubscribers(
      env,
      PROJECT_ID,
      [],
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(0);
    expect(result.failures).toBe(0);
    expect(result.staleEstuaryIds).toEqual([]);
  });

  it("batches writes in groups of 50", async () => {
    // Create 60 estuary streams to verify batching works across boundaries
    const estuaryIds: string[] = [];
    for (let i = 0; i < 60; i++) {
      const id = `fanout-batch-${i}-${crypto.randomUUID()}`;
      estuaryIds.push(id);
      await createEstuaryStream(id);
    }

    const result = await fanoutToSubscribers(
      env,
      PROJECT_ID,
      estuaryIds,
      new TextEncoder().encode("test").buffer as ArrayBuffer,
      "text/plain",
    );

    expect(result.successes).toBe(60);
    expect(result.failures).toBe(0);
  });
});
