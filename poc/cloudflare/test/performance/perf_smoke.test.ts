import { describe, expect, it } from "vitest";
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
    const enforce = process.env.PERF_ENFORCE === "1" && budgetMs > 0;

    const handle = process.env.PERF_BASE_URL ? null : await startWorker();

    const baseUrl = process.env.PERF_BASE_URL ?? handle!.baseUrl;
    const client = createClient(baseUrl);

    const streamId = uniqueStreamId("perf");
    await client.createStream(streamId, "", "text/plain");

    const appendTimes: number[] = [];
    const readTimes: number[] = [];

    const iterations = Number.parseInt(process.env.PERF_ITERATIONS ?? "25", 10);

    for (let i = 0; i < iterations; i += 1) {
      const startAppend = performance.now();
      await client.appendStream(streamId, "x", "text/plain");
      appendTimes.push(performance.now() - startAppend);

      const startRead = performance.now();
      await client.readAllText(streamId, "0");
      readTimes.push(performance.now() - startRead);
    }

    const appendP50 = percentile(appendTimes, 50);
    const appendP95 = percentile(appendTimes, 95);
    const readP50 = percentile(readTimes, 50);
    const readP95 = percentile(readTimes, 95);

    console.log(`[perf] append p50=${appendP50.toFixed(2)}ms p95=${appendP95.toFixed(2)}ms`);
    console.log(`[perf] read   p50=${readP50.toFixed(2)}ms p95=${readP95.toFixed(2)}ms`);
    console.log(
      `[perf] budget target=${budgetMs.toFixed(2)}ms (enforce=${enforce ? "on" : "off"})`,
    );

    if (enforce) {
      expect(appendP95).toBeLessThanOrEqual(budgetMs);
      expect(readP95).toBeLessThanOrEqual(budgetMs);
    }

    if (handle) {
      await handle.stop();
    }
  });
});
