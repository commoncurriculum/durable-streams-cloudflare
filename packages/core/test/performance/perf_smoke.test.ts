import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../src/http/v1/streams/shared/offsets";
import { createClient, uniqueStreamId } from "../implementation/helpers";
import { startWorker } from "../implementation/worker_harness";

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

describe("performance smoke", () => {
  it("measures append/read latencies", async () => {
    const budgetMs = Number.parseFloat(process.env.PERF_BUDGET_MS ?? "10");
    const enforce =
      (process.env.PERF_ENFORCE ? process.env.PERF_ENFORCE === "1" : !!process.env.PERF_BASE_URL) &&
      budgetMs > 0;

    const handle = process.env.PERF_BASE_URL ? null : await startWorker();

    const baseUrl = process.env.PERF_BASE_URL ?? handle!.baseUrl;
    const client = createClient(baseUrl);

    const streamId = uniqueStreamId("perf");
    await client.createStream(streamId, "", "text/plain");

    const appendTimes: number[] = [];
    const readTimes: number[] = [];
    const longPollTimes: number[] = [];

    const iterations = Number.parseInt(process.env.PERF_ITERATIONS ?? "25", 10);
    let lastOffset = ZERO_OFFSET;

    for (let i = 0; i < iterations; i += 1) {
      const startAppend = performance.now();
      const appendResponse = await client.appendStream(streamId, "x", "text/plain");
      appendTimes.push(performance.now() - startAppend);

      const nextOffset = appendResponse.headers.get("Stream-Next-Offset") ?? lastOffset;

      const startRead = performance.now();
      const readResponse = await fetch(client.streamUrl(streamId, { offset: lastOffset }));
      if (readResponse.status !== 200) {
        throw new Error(`perf read failed: ${readResponse.status} ${await readResponse.text()}`);
      }
      await readResponse.arrayBuffer();
      readTimes.push(performance.now() - startRead);

      const startLongPoll = performance.now();
      const longPollResponse = await fetch(
        client.streamUrl(streamId, { offset: lastOffset, live: "long-poll" }),
      );
      if (longPollResponse.status !== 200) {
        throw new Error(
          `perf long-poll failed: ${longPollResponse.status} ${await longPollResponse.text()}`,
        );
      }
      await longPollResponse.arrayBuffer();
      longPollTimes.push(performance.now() - startLongPoll);

      lastOffset = nextOffset;
    }

    const appendP50 = percentile(appendTimes, 50);
    const appendP95 = percentile(appendTimes, 95);
    const readP50 = percentile(readTimes, 50);
    const readP95 = percentile(readTimes, 95);
    const longPollP50 = percentile(longPollTimes, 50);
    const longPollP95 = percentile(longPollTimes, 95);

    console.log(`[perf] append p50=${appendP50.toFixed(2)}ms p95=${appendP95.toFixed(2)}ms`);
    console.log(`[perf] read   p50=${readP50.toFixed(2)}ms p95=${readP95.toFixed(2)}ms`);
    console.log(
      `[perf] long-poll(hit) p50=${longPollP50.toFixed(2)}ms p95=${longPollP95.toFixed(2)}ms`,
    );
    console.log(
      `[perf] budget target=${budgetMs.toFixed(2)}ms (enforce=${enforce ? "on" : "off"})`,
    );

    if (enforce) {
      expect(appendP95).toBeLessThanOrEqual(budgetMs);
      expect(readP95).toBeLessThanOrEqual(budgetMs);
      expect(longPollP95).toBeLessThanOrEqual(budgetMs);
    }

    if (process.env.PERF_LONGPOLL_TIMEOUT === "1") {
      const startTimeout = performance.now();
      const timeoutResponse = await fetch(
        client.streamUrl(streamId, { offset: lastOffset, live: "long-poll" }),
      );
      await timeoutResponse.arrayBuffer();
      const timeoutMs = performance.now() - startTimeout;
      console.log(`[perf] long-poll(timeout) ${timeoutMs.toFixed(2)}ms`);
    }

    if (handle) {
      await handle.stop();
    }
  });
});
