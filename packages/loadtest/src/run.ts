#!/usr/bin/env npx tsx
/**
 * Load test runner for durable-streams core.
 *
 * Simulates N browser clients each holding a persistent SSE or long-poll
 * connection, while writers push messages at a configurable rate.
 *
 * Two modes:
 *
 *   LOCAL MODE (default — single process, no edge cache testing):
 *     pnpm start
 *     pnpm start -- --clients 100 --streams 10 --sse-ratio 0.5 --duration 300
 *
 *   DISTRIBUTED MODE (real edge testing with deployed load test Worker):
 *     pnpm start -- --url https://core.example.com \
 *       --worker-url https://durable-streams-loadtest.your-account.workers.dev \
 *       --project-id myapp --secret mysecret \
 *       --clients 1000 --streams 1 --sse-ratio 0.5 --duration 300
 *
 * Options:
 *   --url              Core worker URL for readers (CDN-proxied). Omit to start local auth-free worker.
 *   --write-url        Direct Worker URL for writes (bypasses CDN proxy). Falls back to --url.
 *   --worker-url       Load test Worker URL. When provided, switches to distributed mode.
 *   --project-id       Project ID (default: "loadtest")
 *   --secret           Signing secret (omit for auth-free)
 *   --clients          Total reader connections to hold open (default: 100)
 *   --streams          Number of streams to spread clients across (default: 10)
 *   --sse-ratio        Fraction of clients using SSE vs long-poll, 0.0-1.0 (default: 1.0)
 *   --write-interval   ms between writes to each stream (default: 1000)
 *   --duration         Test duration in seconds (default: 300)
 *   --ramp-up          Seconds to stagger client connections (default: 10)
 *   --msg-size         Approximate message body size in bytes (default: 256)
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DurableStream } from "@durable-streams/client";
import { signJwt } from "./jwt";
import {
  createOpMetrics, recordSuccess, recordError, summarize,
  createCacheStats, recordCacheHeader,
  createDeliveryStats, recordDelivery, summarizeDelivery,
} from "./metrics";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_CWD = path.resolve(__dirname, "..", "..", "core");

// ============================================================================
// CLI args
// ============================================================================

const rawArgs = process.argv.slice(2).filter((a) => a !== "--");

const { values: args } = parseArgs({
  args: rawArgs,
  options: {
    url: { type: "string" },
    "write-url": { type: "string" },
    "worker-url": { type: "string" },
    "project-id": { type: "string", default: "loadtest" },
    secret: { type: "string" },
    clients: { type: "string", default: "100" },
    streams: { type: "string", default: "10" },
    "sse-ratio": { type: "string", default: "1.0" },
    "write-interval": { type: "string", default: "1000" },
    duration: { type: "string", default: "300" },
    "ramp-up": { type: "string", default: "10" },
    "msg-size": { type: "string", default: "256" },
  },
  strict: true,
  allowPositionals: false,
});

const projectId = args["project-id"]!;
const workerUrl = args["worker-url"] ?? null;
const secret = args.secret ?? null;
const totalClients = parseInt(args.clients!, 10);
const streamCount = parseInt(args.streams!, 10);
const sseRatio = parseFloat(args["sse-ratio"]!);
const writeIntervalMs = parseInt(args["write-interval"]!, 10);
const durationSec = parseInt(args.duration!, 10);
const rampUpSec = parseInt(args["ramp-up"]!, 10);
const msgSize = parseInt(args["msg-size"]!, 10);

const sseClients = Math.round(totalClients * sseRatio);
const longPollClients = totalClients - sseClients;

// ============================================================================
// Worker harness (same pattern as core tests)
// ============================================================================

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to resolve port")));
        return;
      }
      const port = address.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForReady(url: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response) return;
    } catch { /* not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`worker did not start within ${timeoutMs}ms`);
}

interface WorkerHandle {
  baseUrl: string;
  stop: () => Promise<void>;
}

async function startCoreWorker(): Promise<WorkerHandle> {
  const port = await getAvailablePort();
  const persistDir = await mkdtemp(path.join(tmpdir(), "loadtest-core-"));

  const child = spawn(
    "pnpm",
    [
      "exec", "wrangler", "dev",
      "--local",
      "--port", String(port),
      "--config", "wrangler.test.toml",
      "--persist-to", persistDir,
      "--log-level", "warn",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: CORE_CWD,
      stdio: "pipe",
      env: { ...process.env, CI: "1" },
    },
  );

  child.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) process.stderr.write(`  [core] ${line}\n`);
  });

  const baseUrl = `http://localhost:${port}`;
  await waitForReady(`${baseUrl}/health`);

  return {
    baseUrl,
    stop: async () => {
      if (!child.killed) child.kill("SIGTERM");
      await once(child, "exit");
    },
  };
}

// ============================================================================
// Auth helper
// ============================================================================

async function makeHeaders(): Promise<Record<string, string>> {
  if (!secret) return {};
  const token = await signJwt(projectId, secret, "write", 7200);
  return { Authorization: `Bearer ${token}` };
}

// ============================================================================
// Worker summary type (matches worker.ts response)
// ============================================================================

interface WorkerSummary {
  eventsReceived: number;
  batches: number;
  errors: number;
  errorMessage?: string;
  cacheHeaders: Record<string, number>;
  xCacheHeaders: Record<string, number>;
  offsetPolls: Record<string, number>;
  cfPops?: Record<string, number>;
  offsetCacheStatus?: Record<string, Record<string, number>>;
  deliveryLatency: {
    avg: number;
    p50: number;
    p90: number;
    p99: number;
    max: number;
  };
}

// ============================================================================
// Distributed mode
// ============================================================================

async function runDistributed(coreUrl: string, writeUrl?: string) {
  const auth = await makeHeaders();
  // Writers use writeUrl (direct to Worker, bypasses CDN proxy) when provided,
  // otherwise fall back to coreUrl. Readers always use coreUrl (through CDN).
  const writerBaseUrl = writeUrl ?? coreUrl;

  // ── Create streams on core via HTTP ───────────────────────────────
  console.log(`\nCreating ${streamCount} streams on ${writerBaseUrl}...`);
  const streamIds: string[] = [];
  const durableStreams: DurableStream[] = [];

  for (let i = 0; i < streamCount; i++) {
    const id = `loadtest-${Date.now()}-${i}`;
    streamIds.push(id);
    const ds = await DurableStream.create({
      url: `${writerBaseUrl}/v1/stream/${projectId}/${id}`,
      contentType: "application/json",
      headers: auth,
    });
    durableStreams.push(ds);
  }
  console.log(`  Created: ${streamIds.join(", ")}`);

  // ── Sign auth tokens for readers ──────────────────────────────────
  let readToken: string | undefined;
  if (secret) {
    readToken = await signJwt(projectId, secret, "read", durationSec + 300);
  }

  // ── Writer loops (run on orchestrator) ────────────────────────────
  const writeMetrics = createOpMetrics();
  const deadline = Date.now() + durationSec * 1000;
  const startTime = Date.now();
  const msgPayload = "x".repeat(Math.max(0, msgSize - 30));

  const writers = durableStreams.map((ds, streamIdx) =>
    (async () => {
      let seq = 0;
      while (Date.now() < deadline) {
        const body = JSON.stringify({ t: Date.now(), seq: seq++, s: streamIdx, d: msgPayload });
        const start = Date.now();
        try {
          await ds.append(body);
          recordSuccess(writeMetrics, Date.now() - start);
        } catch {
          recordError(writeMetrics);
        }
        await sleep(writeIntervalMs);
      }
    })(),
  );

  // ── Fire N requests to load test Worker ───────────────────────────
  console.log(`\n${"═".repeat(70)}`);
  console.log(`DISTRIBUTED LOAD TEST: ${totalClients} workers → ${workerUrl}`);
  console.log(`  ${sseClients} SSE + ${longPollClients} long-poll across ${streamCount} streams`);
  console.log(`  reads:  ${coreUrl}`);
  if (writeUrl && writeUrl !== coreUrl) console.log(`  writes: ${writerBaseUrl} (direct, bypasses CDN proxy)`);
  console.log(`  write every ${writeIntervalMs}ms, ${durationSec}s duration, msg ~${msgSize}B`);
  console.log(`  ramp-up: ${rampUpSec}s`);
  console.log(`${"═".repeat(70)}`);
  console.log(`\n  NOTE: CF-CACHE-STATUS numbers from distributed mode are NOT`);
  console.log(`  production-representative. CF Worker subrequests do not coalesce`);
  console.log(`  at the CDN level (~10 MISSes/key vs 1 for real clients).`);
  console.log(`  For production-representative CDN numbers, run diagnose-cdn.ts`);
  console.log(`  from an external machine. See packages/loadtest/README.md.\n`);

  let completed = 0;
  let failed = 0;
  const summaries: WorkerSummary[] = [];

  const progressInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    const writeRps = elapsed > 0 ? Math.round(writeMetrics.count / elapsed) : 0;

    process.stdout.write(
      `\r  [${elapsed}s / ${elapsed + remaining}s] ` +
      `workers: ${completed}/${totalClients} done (${failed} failed) | ` +
      `writes: ${writeMetrics.count} (${writeRps}/s, ${writeMetrics.errors} err)`,
    );
  }, 2000);

  const workerRequests: Promise<void>[] = [];
  const rampDelayMs = (rampUpSec * 1000) / Math.max(totalClients, 1);

  for (let i = 0; i < totalClients; i++) {
    const streamIdx = i % streamCount;
    const mode: "sse" | "long-poll" = i < sseClients ? "sse" : "long-poll";

    workerRequests.push(
      (async () => {
        await sleep(i * rampDelayMs);

        const config = {
          coreUrl,
          projectId,
          streamId: streamIds[streamIdx],
          mode,
          durationSec: Math.max(1, durationSec - Math.round((i * rampDelayMs) / 1000)),
          authToken: readToken,
          msgSize,
        };

        try {
          const res = await fetch(workerUrl!, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config),
          });

          if (!res.ok) {
            const text = await res.text();
            console.error(`\n  Worker ${i} failed (${res.status}): ${text}`);
            failed++;
            return;
          }

          const summary = (await res.json()) as WorkerSummary;
          summaries.push(summary);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`\n  Worker ${i} error: ${msg}`);
          failed++;
        } finally {
          completed++;
        }
      })(),
    );
  }

  // Wait for all workers + writers to finish
  await Promise.allSettled([...workerRequests, ...writers]);
  clearInterval(progressInterval);

  const elapsedSec = Math.round((Date.now() - startTime) / 1000);

  // ── Aggregate summaries ───────────────────────────────────────────
  const totalEvents = summaries.reduce((sum, s) => sum + s.eventsReceived, 0);
  const totalBatches = summaries.reduce((sum, s) => sum + s.batches, 0);
  const totalErrors = summaries.reduce((sum, s) => sum + s.errors, 0);

  // Merge cf-cache-status header counts
  const mergedCache: Record<string, number> = {};
  for (const s of summaries) {
    for (const [key, count] of Object.entries(s.cacheHeaders)) {
      mergedCache[key] = (mergedCache[key] ?? 0) + count;
    }
  }

  // Merge x-cache header counts
  const mergedXCache: Record<string, number> = {};
  for (const s of summaries) {
    for (const [key, count] of Object.entries(s.xCacheHeaders ?? {})) {
      mergedXCache[key] = (mergedXCache[key] ?? 0) + count;
    }
  }

  // Aggregate offset polls for drift analysis (H2)
  // Each worker reports which offsets it polled at. Count unique offsets per worker.
  const offsetsPerWorker: number[] = [];
  for (const s of summaries) {
    if (s.offsetPolls) {
      offsetsPerWorker.push(Object.keys(s.offsetPolls).length);
    }
  }

  // Aggregate latency (weighted average, take max of maxes)
  const allLatencies = summaries
    .filter((s) => s.eventsReceived > 0)
    .map((s) => s.deliveryLatency);

  let aggAvg = 0;
  let aggMax = 0;
  let aggP50 = 0;
  let aggP90 = 0;
  let aggP99 = 0;
  if (allLatencies.length > 0) {
    const totalWithEvents = summaries.reduce(
      (sum, s) => sum + (s.eventsReceived > 0 ? s.eventsReceived : 0), 0,
    );
    for (const s of summaries) {
      if (s.eventsReceived === 0) continue;
      const weight = s.eventsReceived / totalWithEvents;
      aggAvg += s.deliveryLatency.avg * weight;
      aggP50 += s.deliveryLatency.p50 * weight;
      aggP90 += s.deliveryLatency.p90 * weight;
      aggP99 += s.deliveryLatency.p99 * weight;
      if (s.deliveryLatency.max > aggMax) aggMax = s.deliveryLatency.max;
    }
  }

  // ── Print summary ─────────────────────────────────────────────────
  console.log("\n\n" + "═".repeat(70));
  console.log(`DISTRIBUTED LOAD TEST COMPLETE — ${elapsedSec}s`);
  console.log("═".repeat(70));

  console.log(`\n  CONFIG`);
  console.log(`    mode:           distributed (${workerUrl})`);
  console.log(`    clients:        ${totalClients} (${sseClients} SSE + ${longPollClients} long-poll)`);
  console.log(`    streams:        ${streamCount}`);
  console.log(`    clients/stream: ${Math.round(totalClients / streamCount)}`);
  console.log(`    write interval: ${writeIntervalMs}ms`);
  console.log(`    msg size:       ~${msgSize}B`);

  console.log(`\n  WORKERS`);
  console.log(`    completed:  ${summaries.length}/${totalClients}`);
  console.log(`    failed:     ${failed}`);

  const ws = summarize(writeMetrics);
  console.log(`\n  WRITES (from orchestrator)`);
  console.log(`    count:  ${ws.count} (${ws.errors} errors)`);
  console.log(`    rps:    ${elapsedSec > 0 ? Math.round(ws.count / elapsedSec) : 0}`);
  console.log(`    avg:    ${ws.avgMs}ms  p50: ${ws.p50Ms}ms  p90: ${ws.p90Ms}ms  p99: ${ws.p99Ms}ms  max: ${ws.maxMs}ms`);

  console.log(`\n  READERS (aggregated from ${summaries.length} workers)`);
  console.log(`    total events: ${totalEvents}`);
  console.log(`    total batches: ${totalBatches}`);
  console.log(`    total errors:  ${totalErrors}`);

  const errorMessages = summaries.filter((s) => s.errorMessage).map((s) => s.errorMessage!);
  if (errorMessages.length > 0) {
    const unique = [...new Set(errorMessages)];
    console.log(`    error details:`);
    for (const msg of unique) {
      const count = errorMessages.filter((m) => m === msg).length;
      console.log(`      (${count}x) ${msg}`);
    }
  }

  if (allLatencies.length > 0) {
    console.log(`\n  EVENT DELIVERY LATENCY (weighted across workers)`);
    console.log(`    avg: ${Math.round(aggAvg)}ms  p50: ${Math.round(aggP50)}ms  p90: ${Math.round(aggP90)}ms  p99: ${Math.round(aggP99)}ms  max: ${aggMax}ms`);
  }

  console.log(`\n  CF-CACHE-STATUS (not production-representative — see note above)`);
  const totalCacheEntries = Object.values(mergedCache).reduce((a, b) => a + b, 0);
  if (totalCacheEntries > 0) {
    for (const [header, count] of Object.entries(mergedCache).sort((a, b) => b[1] - a[1])) {
      const pct = Math.round((count / totalCacheEntries) * 100);
      console.log(`    ${header}: ${count} (${pct}%)`);
    }
  } else {
    console.log(`    (no cf-cache-status headers observed)`);
  }

  console.log(`\n  X-CACHE (edge worker cache)`);
  const totalXCacheEntries = Object.values(mergedXCache).reduce((a, b) => a + b, 0);
  if (totalXCacheEntries > 0) {
    for (const [header, count] of Object.entries(mergedXCache).sort((a, b) => b[1] - a[1])) {
      const pct = Math.round((count / totalXCacheEntries) * 100);
      console.log(`    ${header}: ${count} (${pct}%)`);
    }
  } else {
    console.log(`    (no x-cache headers observed)`);
  }

  if (offsetsPerWorker.length > 0) {
    const avgOffsets = offsetsPerWorker.reduce((a, b) => a + b, 0) / offsetsPerWorker.length;
    const maxOffsets = Math.max(...offsetsPerWorker);
    const minOffsets = Math.min(...offsetsPerWorker);
    console.log(`\n  OFFSET DRIFT (H2 diagnostic)`);
    console.log(`    unique offsets per worker: avg ${avgOffsets.toFixed(1)}, min ${minOffsets}, max ${maxOffsets}`);
    console.log(`    (Higher values mean followers processed more write cycles.`);
    console.log(`     If workers on the same stream have very different counts,`);
    console.log(`     they are drifting apart in offset — fragmenting cache keys.)`);
  }

  // ── CDN PoP distribution ──────────────────────────────────────────
  const mergedPops: Record<string, number> = {};
  for (const s of summaries) {
    if (s.cfPops) {
      for (const [pop, count] of Object.entries(s.cfPops)) {
        mergedPops[pop] = (mergedPops[pop] ?? 0) + count;
      }
    }
  }
  const popEntries = Object.entries(mergedPops).sort((a, b) => b[1] - a[1]);
  if (popEntries.length > 0) {
    const totalPopReqs = popEntries.reduce((sum, [, c]) => sum + c, 0);
    console.log(`\n  CDN PoP DISTRIBUTION`);
    for (const [pop, count] of popEntries) {
      const pct = Math.round((count / totalPopReqs) * 100);
      console.log(`    ${pop}: ${count} (${pct}%)`);
    }
    if (popEntries.length > 1) {
      console.log(`    ⚠ ${popEntries.length} PoPs — each has its own cache, multiplying MISSes`);
    }
  }

  // ── Per-offset MISS analysis ──────────────────────────────────────
  // Merge per-offset cache status across all workers to see how many
  // MISSes each offset generates across the fleet.
  const globalOffsetCache: Record<string, Record<string, number>> = {};
  for (const s of summaries) {
    if (s.offsetCacheStatus) {
      for (const [offset, statusMap] of Object.entries(s.offsetCacheStatus)) {
        if (!globalOffsetCache[offset]) globalOffsetCache[offset] = {};
        for (const [status, count] of Object.entries(statusMap)) {
          globalOffsetCache[offset][status] = (globalOffsetCache[offset][status] ?? 0) + count;
        }
      }
    }
  }
  const offsetEntries = Object.entries(globalOffsetCache);
  if (offsetEntries.length > 0) {
    const missesPerOffset = offsetEntries.map(([, m]) => m["MISS"] ?? 0).filter((n) => n > 0);
    if (missesPerOffset.length > 0) {
      const sorted = missesPerOffset.slice().sort((a, b) => a - b);
      const avgMiss = sorted.reduce((a, b) => a + b, 0) / sorted.length;
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p90 = sorted[Math.floor(sorted.length * 0.9)];
      const maxMiss = sorted[sorted.length - 1];
      console.log(`\n  MISSes PER OFFSET (across all ${summaries.length} workers)`);
      console.log(`    offsets with MISSes: ${missesPerOffset.length}/${offsetEntries.length}`);
      console.log(`    MISSes per offset: avg ${avgMiss.toFixed(1)}, p50 ${p50}, p90 ${p90}, max ${maxMiss}`);
      console.log(`    (With perfect CDN coalescing, each offset should have exactly 1 MISS.`);
      console.log(`     Higher values indicate multi-PoP fragmentation or coalescing failure.)`);
    }
  }

  console.log("\n" + "═".repeat(70));
}

// ============================================================================
// Local mode (original single-process behavior)
// ============================================================================

async function runLocal(coreUrl: string) {
  const auth = await makeHeaders();

  // ── Custom fetch that tracks cf-cache-status and x-cache headers ────
  const cacheStats = createCacheStats();
  const xCacheStats = createCacheStats();

  const trackingFetch: typeof globalThis.fetch = async (input, init) => {
    const res = await globalThis.fetch(input, init);
    recordCacheHeader(cacheStats, res.headers.get("cf-cache-status"));
    recordCacheHeader(xCacheStats, res.headers.get("x-cache"));
    return res;
  };

  // ── Create streams ──────────────────────────────────────────────────
  console.log(`\nCreating ${streamCount} streams...`);
  const streamIds: string[] = [];
  const durableStreams: DurableStream[] = [];

  for (let i = 0; i < streamCount; i++) {
    const id = `loadtest-${Date.now()}-${i}`;
    streamIds.push(id);
    const ds = await DurableStream.create({
      url: `${coreUrl}/v1/stream/${projectId}/${id}`,
      contentType: "application/json",
      headers: auth,
      fetch: trackingFetch,
    });
    durableStreams.push(ds);
  }
  console.log(`  Created: ${streamIds.join(", ")}`);

  // ── Metrics ─────────────────────────────────────────────────────────
  const writeMetrics = createOpMetrics();
  const sseMetrics = createOpMetrics();
  const longPollMetrics = createOpMetrics();
  const deliveryStats = createDeliveryStats();

  const deadline = Date.now() + durationSec * 1000;
  const startTime = Date.now();
  const abortController = new AbortController();
  let activeConnections = 0;
  let eventsReceived = 0;

  // ── Writers ─────────────────────────────────────────────────────────
  // One writer per stream, appending at writeIntervalMs
  const msgPayload = "x".repeat(Math.max(0, msgSize - 30)); // leave room for JSON wrapper

  const writers = durableStreams.map((ds, streamIdx) =>
    (async () => {
      let seq = 0;
      while (Date.now() < deadline) {
        const body = JSON.stringify({ t: Date.now(), seq: seq++, s: streamIdx, d: msgPayload });
        const start = Date.now();
        try {
          await ds.append(body);
          recordSuccess(writeMetrics, Date.now() - start);
        } catch {
          recordError(writeMetrics);
        }
        await sleep(writeIntervalMs);
      }
    })(),
  );

  // ── SSE readers ─────────────────────────────────────────────────────
  const rampDelayMs = (rampUpSec * 1000) / Math.max(totalClients, 1);
  const readers: Promise<void>[] = [];

  for (let i = 0; i < sseClients; i++) {
    const streamIdx = i % streamCount;
    const ds = durableStreams[streamIdx];

    readers.push(
      (async () => {
        await sleep(i * rampDelayMs);
        if (Date.now() >= deadline) return;
        activeConnections++;

        try {
          const res = await ds.stream<{ t: number; seq: number }>({
            live: "sse",
            offset: "now",
            signal: abortController.signal,
            headers: auth,
            fetch: trackingFetch,
          });

          await res.subscribeJson(async (batch) => {
            const now = Date.now();
            for (const item of batch.items) {
              eventsReceived++;
              if (typeof item.t === "number") {
                recordDelivery(deliveryStats, now - item.t);
              }
            }
            recordSuccess(sseMetrics, 1);
          });
        } catch (err: unknown) {
          if (err instanceof Error && err.name === "AbortError") return;
          recordError(sseMetrics);
        } finally {
          activeConnections--;
        }
      })(),
    );
  }

  // ── Long-poll readers ───────────────────────────────────────────────
  for (let i = 0; i < longPollClients; i++) {
    const streamIdx = (sseClients + i) % streamCount;
    const ds = durableStreams[streamIdx];

    readers.push(
      (async () => {
        await sleep((sseClients + i) * rampDelayMs);
        if (Date.now() >= deadline) return;
        activeConnections++;

        try {
          const res = await ds.stream<{ t: number; seq: number }>({
            live: "long-poll",
            offset: "now",
            signal: abortController.signal,
            headers: auth,
            fetch: trackingFetch,
          });

          await res.subscribeJson(async (batch) => {
            const now = Date.now();
            for (const item of batch.items) {
              eventsReceived++;
              if (typeof item.t === "number") {
                recordDelivery(deliveryStats, now - item.t);
              }
            }
            recordSuccess(longPollMetrics, 1);
          });
        } catch (err: unknown) {
          if (err instanceof Error && err.name === "AbortError") return;
          recordError(longPollMetrics);
        } finally {
          activeConnections--;
        }
      })(),
    );
  }

  // ── Progress reporting ──────────────────────────────────────────────
  console.log(`\n${"═".repeat(70)}`);
  console.log(`LOAD TEST: ${totalClients} clients (${sseClients} SSE + ${longPollClients} long-poll)`);
  console.log(`           ${streamCount} streams, write every ${writeIntervalMs}ms, ${durationSec}s duration`);
  console.log(`           msg size ~${msgSize}B, ramp-up ${rampUpSec}s`);
  console.log(`${"═".repeat(70)}\n`);

  const progressInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    const writeRps = elapsed > 0 ? Math.round(writeMetrics.count / elapsed) : 0;
    const evtRate = elapsed > 0 ? Math.round(eventsReceived / elapsed) : 0;

    process.stdout.write(
      `\r  [${elapsed}s / ${elapsed + remaining}s] ` +
      `conns: ${activeConnections} | ` +
      `writes: ${writeMetrics.count} (${writeRps}/s, ${writeMetrics.errors} err) | ` +
      `events rx: ${eventsReceived} (${evtRate}/s) | ` +
      `sse batches: ${sseMetrics.count} | ` +
      `lp batches: ${longPollMetrics.count}`,
    );
  }, 2000);

  // ── Wait for completion ─────────────────────────────────────────────
  // Writers run until deadline, then we abort all readers
  await Promise.all(writers);
  // Give readers a moment to receive final events
  await sleep(2000);
  abortController.abort();
  await Promise.allSettled(readers);
  clearInterval(progressInterval);

  const elapsedSec = Math.round((Date.now() - startTime) / 1000);

  // ── Summary ─────────────────────────────────────────────────────────
  console.log("\n\n" + "═".repeat(70));
  console.log(`LOAD TEST COMPLETE — ${elapsedSec}s`);
  console.log("═".repeat(70));

  console.log(`\n  CONFIG`);
  console.log(`    clients:        ${totalClients} (${sseClients} SSE + ${longPollClients} long-poll)`);
  console.log(`    streams:        ${streamCount}`);
  console.log(`    clients/stream: ${Math.round(totalClients / streamCount)}`);
  console.log(`    write interval: ${writeIntervalMs}ms`);
  console.log(`    msg size:       ~${msgSize}B`);

  const ws = summarize(writeMetrics);
  console.log(`\n  WRITES`);
  console.log(`    count:  ${ws.count} (${ws.errors} errors)`);
  console.log(`    rps:    ${elapsedSec > 0 ? Math.round(ws.count / elapsedSec) : 0}`);
  console.log(`    avg:    ${ws.avgMs}ms  p50: ${ws.p50Ms}ms  p90: ${ws.p90Ms}ms  p99: ${ws.p99Ms}ms  max: ${ws.maxMs}ms`);

  if (sseClients > 0) {
    const ss = summarize(sseMetrics);
    console.log(`\n  SSE READERS (${sseClients} connections)`);
    console.log(`    batches received: ${ss.count} (${ss.errors} errors)`);
  }

  if (longPollClients > 0) {
    const ls = summarize(longPollMetrics);
    console.log(`\n  LONG-POLL READERS (${longPollClients} connections)`);
    console.log(`    batches received: ${ls.count} (${ls.errors} errors)`);
  }

  console.log(`\n  EVENT DELIVERY`);
  console.log(`    total events received: ${eventsReceived}`);
  if (deliveryStats.count > 0) {
    const ds = summarizeDelivery(deliveryStats);
    console.log(`    latency: avg ${ds.avgMs}ms  p50: ${ds.p50Ms}ms  p90: ${ds.p90Ms}ms  p99: ${ds.p99Ms}ms  max: ${ds.maxMs}ms`);
  }

  console.log(`\n  CF-CACHE-STATUS`);
  const totalCacheEntries = Object.values(cacheStats.counts).reduce((a, b) => a + b, 0);
  if (totalCacheEntries > 0) {
    for (const [header, count] of Object.entries(cacheStats.counts).sort((a, b) => b[1] - a[1])) {
      const pct = Math.round((count / totalCacheEntries) * 100);
      console.log(`    ${header}: ${count} (${pct}%)`);
    }
  } else {
    console.log(`    (no cf-cache-status headers observed)`);
  }

  console.log(`\n  X-CACHE (edge worker cache)`);
  const totalXCacheEntries = Object.values(xCacheStats.counts).reduce((a, b) => a + b, 0);
  if (totalXCacheEntries > 0) {
    for (const [header, count] of Object.entries(xCacheStats.counts).sort((a, b) => b[1] - a[1])) {
      const pct = Math.round((count / totalXCacheEntries) * 100);
      console.log(`    ${header}: ${count} (${pct}%)`);
    }
  } else {
    console.log(`    (no x-cache headers observed)`);
  }

  console.log("\n" + "═".repeat(70));
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  let coreUrl = args.url;
  let coreHandle: WorkerHandle | null = null;

  if (workerUrl) {
    // Distributed mode — requires a core URL
    if (!coreUrl) {
      console.error("Error: --worker-url requires --url (core must be deployed)");
      process.exit(1);
    }
    await runDistributed(coreUrl, args["write-url"]);
    return;
  }

  // Local mode
  if (!coreUrl) {
    console.log("Starting local core worker (auth-free test mode)...");
    coreHandle = await startCoreWorker();
    coreUrl = coreHandle.baseUrl;
    console.log(`Core running at ${coreUrl}`);
  }

  try {
    await runLocal(coreUrl);
  } finally {
    if (coreHandle) {
      console.log("\nStopping core worker...");
      await coreHandle.stop();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
