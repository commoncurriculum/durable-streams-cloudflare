import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DurableStream } from "@durable-streams/client";
import { afterAll, bench, describe } from "vitest";

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------

const BASE_URL = process.env.BENCHMARK_URL;
const AUTH_TOKEN = process.env.BENCHMARK_AUTH_TOKEN;
const PROJECT = process.env.BENCHMARK_PROJECT ?? "bench";

if (!BASE_URL) throw new Error("BENCHMARK_URL env var is required");
if (!AUTH_TOKEN) throw new Error("BENCHMARK_AUTH_TOKEN env var is required");

const headers: Record<string, string> = { Authorization: `Bearer ${AUTH_TOKEN}` };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function streamUrl(id: string): string {
  return `${BASE_URL}/v1/${PROJECT}/stream/${id}`;
}

function uid(): string {
  return `bench-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function makePayload(bytes: number): string {
  return "x".repeat(bytes);
}

interface Stats {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p75: number;
  p99: number;
  unit: string;
  samples: number;
}

function calcStats(values: number[], unit: string): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    max: sorted[n - 1],
    mean: sum / n,
    p50: sorted[Math.floor(n * 0.5)],
    p75: sorted[Math.floor(n * 0.75)],
    p99: sorted[Math.floor(n * 0.99)],
    unit,
    samples: n,
  };
}

async function ping(): Promise<number> {
  const start = performance.now();
  const res = await fetch(`${BASE_URL}/health`, { headers });
  await res.text();
  return performance.now() - start;
}

async function appendAndReceive(payloadSize: number): Promise<{ totalMs: number; pingMs: number }> {
  const id = uid();
  const url = streamUrl(id);
  const payload = makePayload(payloadSize);

  // Create the stream
  const handle = await DurableStream.create({
    url,
    headers,
    contentType: "application/octet-stream",
    batching: false,
  });

  // Start long-poll reader before appending
  const readerPromise = handle.stream({ live: "long-poll", offset: "-1" });

  const pingMs = await ping();

  const start = performance.now();
  await handle.append(payload);
  const res = await readerPromise;
  await res.body();
  res.cancel();
  const totalMs = performance.now() - start;

  // Cleanup
  try {
    await handle.delete();
  } catch {
    // ignore cleanup errors
  }

  return { totalMs, pingMs };
}

async function runConcurrentAppends(
  msgCount: number,
  payloadSize: number,
  concurrency: number,
): Promise<{ elapsedMs: number; messagesPerSec: number; mbPerSec: number }> {
  const id = uid();
  const url = streamUrl(id);
  const payload = makePayload(payloadSize);

  const handle = await DurableStream.create({
    url,
    headers,
    contentType: "application/octet-stream",
    batching: false,
  });

  const start = performance.now();
  let sent = 0;

  // Send in batches of `concurrency`
  while (sent < msgCount) {
    const batchSize = Math.min(concurrency, msgCount - sent);
    const promises: Promise<void>[] = [];
    for (let i = 0; i < batchSize; i++) {
      promises.push(handle.append(payload));
    }
    await Promise.all(promises);
    sent += batchSize;
  }

  const elapsedMs = performance.now() - start;
  const elapsedSec = elapsedMs / 1000;
  const totalBytes = msgCount * payloadSize;

  // Cleanup
  try {
    await handle.delete();
  } catch {
    // ignore cleanup errors
  }

  return {
    elapsedMs,
    messagesPerSec: msgCount / elapsedSec,
    mbPerSec: totalBytes / (1024 * 1024) / elapsedSec,
  };
}

// ---------------------------------------------------------------------------
// Results collection
// ---------------------------------------------------------------------------

const results: Record<string, unknown> = {};

afterAll(() => {
  const output = {
    timestamp: new Date().toISOString(),
    environment: {
      url: BASE_URL,
      project: PROJECT,
    },
    results,
  };
  const outPath = resolve(process.cwd(), "benchmark-results.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nBenchmark results written to ${outPath}`);
});

// ---------------------------------------------------------------------------
// Latency benchmarks
// ---------------------------------------------------------------------------

describe("latency", () => {
  const pingTimes: number[] = [];
  const overheadTimes: number[] = [];
  const totalTimes: number[] = [];

  bench(
    "baseline ping (/health)",
    async () => {
      const ms = await ping();
      pingTimes.push(ms);
    },
    { iterations: 50, warmupIterations: 5, time: 0 },
  );

  bench(
    "append-and-receive (100B long-poll)",
    async () => {
      const { totalMs, pingMs } = await appendAndReceive(100);
      totalTimes.push(totalMs);
      overheadTimes.push(totalMs - pingMs);
    },
    { iterations: 10, warmupIterations: 1, time: 0 },
  );

  afterAll(() => {
    if (pingTimes.length > 0) {
      results["latency.ping"] = calcStats(pingTimes, "ms");
      console.log("\n--- Baseline Ping ---");
      console.log(JSON.stringify(calcStats(pingTimes, "ms"), null, 2));
    }
    if (totalTimes.length > 0) {
      results["latency.append_receive_total"] = calcStats(totalTimes, "ms");
      results["latency.append_receive_overhead"] = calcStats(overheadTimes, "ms");
      console.log("\n--- Append & Receive (100B) ---");
      console.log("Total:", JSON.stringify(calcStats(totalTimes, "ms"), null, 2));
      console.log("Overhead:", JSON.stringify(calcStats(overheadTimes, "ms"), null, 2));
    }
  });
});

// ---------------------------------------------------------------------------
// Throughput benchmarks
// ---------------------------------------------------------------------------

describe("throughput", () => {
  const smallResults: { messagesPerSec: number; mbPerSec: number }[] = [];
  const largeResults: { messagesPerSec: number; mbPerSec: number }[] = [];

  bench(
    "small messages (100B x 1000, concurrency 75)",
    async () => {
      const r = await runConcurrentAppends(1000, 100, 75);
      smallResults.push({ messagesPerSec: r.messagesPerSec, mbPerSec: r.mbPerSec });
    },
    { iterations: 3, warmupIterations: 0, time: 0 },
  );

  bench(
    "large messages (1MB x 50, concurrency 15)",
    async () => {
      const r = await runConcurrentAppends(50, 1_000_000, 15);
      largeResults.push({ messagesPerSec: r.messagesPerSec, mbPerSec: r.mbPerSec });
    },
    { iterations: 3, warmupIterations: 0, time: 0 },
  );

  afterAll(() => {
    if (smallResults.length > 0) {
      const msgRates = smallResults.map((r) => r.messagesPerSec);
      results["throughput.small.msg_per_sec"] = calcStats(msgRates, "msg/s");
      console.log("\n--- Small Message Throughput (100B x 1000) ---");
      console.log(JSON.stringify(calcStats(msgRates, "msg/s"), null, 2));
    }
    if (largeResults.length > 0) {
      const mbRates = largeResults.map((r) => r.mbPerSec);
      results["throughput.large.mb_per_sec"] = calcStats(mbRates, "MB/s");
      console.log("\n--- Large Message Throughput (1MB x 50) ---");
      console.log(JSON.stringify(calcStats(mbRates, "MB/s"), null, 2));
    }
  });
});
