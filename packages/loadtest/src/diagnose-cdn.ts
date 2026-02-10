#!/usr/bin/env npx tsx
/**
 * CDN Coalescing Diagnostic Tool
 *
 * Tests whether Cloudflare's CDN coalesces concurrent long-poll requests
 * to the same cache key into a single origin request.
 *
 * Hypotheses tested:
 *   H1: CDN doesn't coalesce concurrent long-poll requests
 *   H3: cf-cache-status is misleading for coalesced requests
 *   H5: Reconnection thundering herd overwhelms coalescing
 *
 * Usage:
 *   pnpm diagnose -- --url https://ds-stream.commonplanner.com \
 *     --project-id loadtest --secret mysecret \
 *     --concurrency 10 --stagger 0
 */

import { parseArgs } from "node:util";
import { DurableStream } from "@durable-streams/client";
import { signJwt } from "./jwt";

const rawArgs = process.argv.slice(2).filter((a) => a !== "--");

const { values: args } = parseArgs({
  args: rawArgs,
  options: {
    url: { type: "string" },
    "project-id": { type: "string", default: "loadtest" },
    secret: { type: "string" },
    concurrency: { type: "string", default: "10" },
    stagger: { type: "string", default: "0" },
    rounds: { type: "string", default: "3" },
  },
  strict: true,
  allowPositionals: false,
});

const coreUrl = args.url;
if (!coreUrl) {
  console.error("Error: --url is required (e.g., https://ds-stream.commonplanner.com)");
  process.exit(1);
}

const projectId = args["project-id"]!;
const secret = args.secret ?? null;
const concurrency = parseInt(args.concurrency!, 10);
const staggerMs = parseInt(args.stagger!, 10);
const rounds = parseInt(args.rounds!, 10);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RequestResult {
  index: number;
  status: number;
  cfCacheStatus: string;
  xCache: string;
  elapsedMs: number;
  streamNextOffset: string;
  streamCursor: string;
}

async function makeHeaders(scope: "write" | "read" = "write"): Promise<Record<string, string>> {
  if (!secret) return {};
  const token = await signJwt(projectId, secret, scope, 7200);
  return { Authorization: `Bearer ${token}` };
}

async function fireRequests(
  url: string,
  n: number,
  stagger: number,
  headers: Record<string, string>,
): Promise<RequestResult[]> {
  const results: RequestResult[] = [];

  const tasks = Array.from({ length: n }, (_, i) =>
    (async () => {
      if (stagger > 0) await sleep(i * stagger);
      const start = Date.now();
      const res = await fetch(url, { headers });
      const elapsed = Date.now() - start;

      results.push({
        index: i,
        status: res.status,
        cfCacheStatus: res.headers.get("cf-cache-status") ?? "(none)",
        xCache: res.headers.get("x-cache") ?? "(none)",
        elapsedMs: elapsed,
        streamNextOffset: res.headers.get("stream-next-offset") ?? "",
        streamCursor: res.headers.get("stream-cursor") ?? "",
      });

      // Drain body
      await res.arrayBuffer();
    })(),
  );

  await Promise.allSettled(tasks);
  return results.sort((a, b) => a.index - b.index);
}

function printResults(label: string, results: RequestResult[]) {
  console.log(`\n  ${label}`);
  console.log(`  ${"─".repeat(90)}`);
  console.log(
    `  ${"#".padStart(3)} ${"status".padStart(6)} ${"cf-cache".padEnd(12)} ${"x-cache".padEnd(10)} ${"elapsed".padStart(8)} ${"next-offset".padEnd(40)} cursor`,
  );
  console.log(`  ${"─".repeat(90)}`);

  for (const r of results) {
    console.log(
      `  ${String(r.index).padStart(3)} ${String(r.status).padStart(6)} ${r.cfCacheStatus.padEnd(12)} ${r.xCache.padEnd(10)} ${(r.elapsedMs + "ms").padStart(8)} ${r.streamNextOffset.padEnd(40)} ${r.streamCursor}`,
    );
  }

  // Summary
  const cfCounts: Record<string, number> = {};
  const xCacheCounts: Record<string, number> = {};
  for (const r of results) {
    cfCounts[r.cfCacheStatus] = (cfCounts[r.cfCacheStatus] ?? 0) + 1;
    xCacheCounts[r.xCache] = (xCacheCounts[r.xCache] ?? 0) + 1;
  }

  console.log(`\n  Summary:`);
  console.log(
    `    cf-cache-status: ${Object.entries(cfCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`,
  );
  console.log(
    `    x-cache:         ${Object.entries(xCacheCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`,
  );

  const uniqueOffsets = new Set(results.map((r) => r.streamNextOffset).filter(Boolean));
  const uniqueCursors = new Set(results.map((r) => r.streamCursor).filter(Boolean));
  console.log(`    unique offsets:  ${uniqueOffsets.size} (${[...uniqueOffsets].join(", ")})`);
  console.log(`    unique cursors:  ${uniqueCursors.size} (${[...uniqueCursors].join(", ")})`);
}

/**
 * Do a single long-poll request that resolves when data arrives.
 * Returns the next-offset and cursor from the response for constructing
 * the next poll URL.
 */
async function doLongPoll(
  streamUrl: string,
  offset: string,
  cursor: string | null,
  headers: Record<string, string>,
): Promise<{ nextOffset: string; cursor: string }> {
  let url = `${streamUrl}?offset=${encodeURIComponent(offset)}&live=long-poll`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
  const res = await fetch(url, { headers });
  await res.arrayBuffer();
  return {
    nextOffset: res.headers.get("stream-next-offset") ?? offset,
    cursor: res.headers.get("stream-cursor") ?? "",
  };
}

async function main() {
  const writeHeaders = await makeHeaders("write");
  const readHeaders = await makeHeaders("read");

  // ── Create a test stream and write initial data ───────────────────
  const streamId = `diag-cdn-${Date.now()}`;
  const streamUrl = `${coreUrl}/v1/stream/${projectId}/${streamId}`;

  console.log(`\n${"═".repeat(70)}`);
  console.log(`CDN COALESCING DIAGNOSTIC`);
  console.log(`${"═".repeat(70)}`);
  console.log(`\n  core:        ${coreUrl}`);
  console.log(`  stream:      ${streamId}`);
  console.log(`  concurrency: ${concurrency}`);
  console.log(`  stagger:     ${staggerMs}ms`);
  console.log(`  rounds:      ${rounds}`);

  console.log(`\nCreating stream...`);
  const ds = await DurableStream.create({
    url: streamUrl,
    contentType: "application/json",
    headers: writeHeaders,
  });

  // Write initial messages
  for (let i = 0; i < 3; i++) {
    await ds.append(JSON.stringify({ t: Date.now(), seq: i }));
    await sleep(50);
  }
  console.log(`  Wrote 3 messages.`);

  // ── Test 1: Concurrent mid-stream reads ───────────────────────────
  console.log(`\n${"─".repeat(70)}`);
  console.log(`TEST 1: Concurrent mid-stream reads (offset=-1, no live mode)`);
  console.log(`  Tests basic CDN cache behavior on immutable data.`);
  console.log(`${"─".repeat(70)}`);

  // Prime the cache
  const primeUrl = `${streamUrl}?offset=-1`;
  const primeRes = await fetch(primeUrl, { headers: readHeaders });
  console.log(`  Prime: ${primeRes.status} cf:${primeRes.headers.get("cf-cache-status")} x:${primeRes.headers.get("x-cache")}`);
  await primeRes.arrayBuffer();
  // Give cache time to propagate
  await sleep(200);

  const midStreamResults = await fireRequests(primeUrl, concurrency, staggerMs, readHeaders);
  printResults("Mid-stream concurrent reads (after cache prime)", midStreamResults);

  // ── Bootstrap: get to the tail with a cursor ──────────────────────
  // Read all existing data to reach the tail
  const catchUpRes = await fetch(`${streamUrl}?offset=-1`, { headers: readHeaders });
  const tailOffset = catchUpRes.headers.get("stream-next-offset") ?? "";
  await catchUpRes.arrayBuffer();
  console.log(`\n  Tail offset: ${tailOffset}`);

  // Do one long-poll to get a cursor (write first so it resolves immediately)
  await ds.append(JSON.stringify({ t: Date.now(), seq: 50 }));
  await sleep(100);
  const bootstrap = await doLongPoll(streamUrl, tailOffset, null, readHeaders);
  console.log(`  Bootstrap long-poll: next=${bootstrap.nextOffset} cursor=${bootstrap.cursor}`);

  // ── Test 2: Concurrent long-poll reads at tail ────────────────────
  let currentOffset = bootstrap.nextOffset;
  let currentCursor = bootstrap.cursor;

  for (let round = 0; round < rounds; round++) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`TEST 2 (round ${round + 1}/${rounds}): Concurrent long-poll at tail`);
    console.log(`  ${concurrency} concurrent requests, same offset+cursor, write after 500ms`);
    console.log(`${"─".repeat(70)}`);

    const lpUrl = `${streamUrl}?offset=${encodeURIComponent(currentOffset)}&live=long-poll&cursor=${encodeURIComponent(currentCursor)}`;
    console.log(`  URL params: offset=${currentOffset} cursor=${currentCursor}`);

    // Fire write after 500ms to resolve the long-polls
    const writePromise = (async () => {
      await sleep(500);
      await ds.append(JSON.stringify({ t: Date.now(), seq: 100 + round }));
    })();

    const lpResults = await fireRequests(lpUrl, concurrency, staggerMs, readHeaders);
    await writePromise;

    printResults(`Long-poll at tail (round ${round + 1})`, lpResults);

    // Advance offset+cursor from the first successful response
    const ok = lpResults.find((r) => r.status === 200 && r.streamNextOffset);
    if (ok) {
      currentOffset = ok.streamNextOffset;
      currentCursor = ok.streamCursor;
    }
  }

  // ── Test 3: Staggered long-poll (H5) ─────────────────────────────
  if (staggerMs === 0) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`TEST 3: Staggered long-poll reads (10ms between each)`);
    console.log(`  Tests H5: whether small stagger improves coalescing.`);
    console.log(`${"─".repeat(70)}`);

    const lpUrl = `${streamUrl}?offset=${encodeURIComponent(currentOffset)}&live=long-poll&cursor=${encodeURIComponent(currentCursor)}`;
    console.log(`  URL params: offset=${currentOffset} cursor=${currentCursor}`);

    const writePromise = (async () => {
      await sleep(500);
      await ds.append(JSON.stringify({ t: Date.now(), seq: 200 }));
    })();

    const staggeredResults = await fireRequests(lpUrl, concurrency, 10, readHeaders);
    await writePromise;

    printResults("Staggered long-poll (10ms between each)", staggeredResults);

    const ok = staggeredResults.find((r) => r.status === 200 && r.streamNextOffset);
    if (ok) {
      currentOffset = ok.streamNextOffset;
      currentCursor = ok.streamCursor;
    }
  }

  // ── Test 4: High concurrency (H1 + H5 at scale) ──────────────────
  console.log(`\n${"─".repeat(70)}`);
  console.log(`TEST 4: High concurrency (${concurrency * 5} requests)`);
  console.log(`  Same test as Test 2 but 5x the concurrency.`);
  console.log(`${"─".repeat(70)}`);

  const lpUrl4 = `${streamUrl}?offset=${encodeURIComponent(currentOffset)}&live=long-poll&cursor=${encodeURIComponent(currentCursor)}`;

  const writePromise4 = (async () => {
    await sleep(500);
    await ds.append(JSON.stringify({ t: Date.now(), seq: 300 }));
  })();

  const highConcResults = await fireRequests(lpUrl4, concurrency * 5, staggerMs, readHeaders);
  await writePromise4;

  printResults(`High concurrency (${concurrency * 5} requests)`, highConcResults);

  // ── Analysis ──────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(70)}`);
  console.log(`ANALYSIS`);
  console.log(`${"═".repeat(70)}`);

  // H3 analysis: compare X-Cache vs cf-cache-status across all long-poll tests
  const allLpResults = highConcResults.filter((r) => r.status === 200);
  if (allLpResults.length > 0) {
    const xMiss = allLpResults.filter((r) => r.xCache === "MISS").length;
    const cfMiss = allLpResults.filter((r) => r.cfCacheStatus === "MISS").length;
    const xHit = allLpResults.filter((r) => r.xCache === "HIT").length;
    const cfHit = allLpResults.filter((r) => r.cfCacheStatus === "HIT").length;
    const cfNone = allLpResults.filter((r) => r.cfCacheStatus === "(none)").length;
    const total = allLpResults.length;

    console.log(`\n  H3: Are cf-cache-status headers misleading?`);
    console.log(`    (from Test 4 — ${total} successful long-poll responses)`);
    console.log(`    cf-cache-status:  MISS=${cfMiss} HIT=${cfHit} (none)=${cfNone}`);
    console.log(`    x-cache:          MISS=${xMiss} HIT=${xHit}`);

    if (xMiss > cfMiss) {
      console.log(`\n    → X-Cache reports MORE MISSes than cf-cache-status.`);
      console.log(`      The CDN is coalescing/caching responses BEFORE they reach`);
      console.log(`      the edge worker's caches.default. CDN-level HIT requests`);
      console.log(`      never execute the Worker, so X-Cache shows MISS (from the`);
      console.log(`      Worker's perspective, it never saw those requests).`);
      console.log(`      H3 CONFIRMED: cf-cache-status is the accurate metric.`);
      console.log(`      X-Cache undercounts HITs because CDN serves before Worker runs.`);
    } else if (cfMiss > xMiss) {
      console.log(`\n    → cf-cache-status reports MORE MISSes than X-Cache.`);
      console.log(`      The Worker's caches.default is coalescing better than CDN.`);
    } else {
      console.log(`\n    → Both headers agree.`);
    }

    const hitRate = total > 0 ? Math.round((cfHit / total) * 100) : 0;
    console.log(`\n  CDN HIT rate: ${hitRate}% (${cfHit}/${total})`);

    if (hitRate > 90) {
      console.log(`    CDN coalescing is working well.`);
    } else if (hitRate > 50) {
      console.log(`    CDN coalescing is partially effective.`);
      console.log(`    The gap is likely due to the cache.put() propagation window.`);
    } else if (hitRate > 0) {
      console.log(`    CDN coalescing is weak — most requests miss the cache.`);
    } else {
      console.log(`    CDN is NOT coalescing at all.`);
    }
  }

  console.log(`\n${"═".repeat(70)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
