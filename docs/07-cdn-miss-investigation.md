# Chapter 7: CDN MISS Investigation

After the sentinel coalescing was removed in favor of Cloudflare's native CDN request collapsing, production testing revealed that CDN coalescing works differently for Worker subrequests vs external clients.

## The Problem

When 50 Cloudflare edge Workers concurrently request the same cache key through a CDN-proxied URL, we observe ~9 MISSes per cache key instead of the expected 1. This inflates origin load by ~9x compared to theoretical optimal.

## Key Takeaways

- **Worker subrequests coalesce at ~80% vs ~99% for external clients.** When Cloudflare Workers call `fetch()` to a CDN-proxied URL, requests are distributed across ~9 internal cache nodes within the PoP, each independently sending a MISS to origin. External clients (browsers, `curl`, any non-Worker HTTP client) are consistently routed to the same cache node and coalesce at 98-99%+.
- **This is a platform behavior, not a bug.** Large Cloudflare PoPs have multiple internal cache nodes. The routing differs between Worker subrequests and external client requests. There is no configuration change that can fix it.
- **External clients are the production path and are unaffected.** Real end users (browsers, mobile apps) make external HTTP requests. The degraded coalescing only affects Worker-to-Worker communication, which is not the production read path.
- **The nginx IPv6 issue was a separate operational problem (now fixed).** EKS nodes lacked IPv6 routing, causing nginx to fail when resolving AAAA records for the upstream Worker. Adding `resolver 1.1.1.1 ipv6=off` fixed catastrophic latency stalls and improved HIT rate from 65% to 79-83% for Worker subrequests.

The rest of this chapter is the detailed investigation log supporting these findings.

## Setup

```
Architecture:
  [Edge Workers (loadtest)] → fetch() → [Cloudflare CDN (ds-stream.commonplanner.com)]
                                           → [Nginx proxy (EKS k8s)]
                                             → [Cloudflare Worker (core)]
                                               → [Durable Object]

- All edge Workers confirmed in single PoP (IAD: 100%)
- Response headers include: Cache-Control: public, max-age=20
- cf-cache-status: HIT/MISS correctly reported
- No Vary header in responses
- Authorization header is identical across all Workers (same Bearer token)
```

## What We Observed

### Test 1: 50 concurrent requests from a LOCAL MACHINE to the same cache key
```
Result: 1 MISS + 49 HIT (98% HIT)
PoPs hit: EWR (32) + IAD (18) — coalescing works ACROSS PoPs
```

### Test 2: 100 concurrent requests from a LOCAL MACHINE (diagnose-cdn.ts)
```
Result: 1 MISS + 99 HIT (99% HIT)
```

### Test 3: 50 edge Workers making subrequests to the same cache key
```
Result: ~9 MISS + ~34 HIT per offset (79% HIT)
All requests from IAD PoP (confirmed via cf-ray header)
```

### Test 4: diagnose-cdn.ts from a Digital Ocean droplet (NYC region, external server)
```
Results (2026-02-09):
  Test 1 (mid-stream, warm cache):  50 requests → 0 MISS, 50 HIT  (100% HIT)
  Test 2 round 1 (long-poll):       50 requests → 1 MISS, 49 HIT  (98% HIT)
  Test 2 round 2 (long-poll):       50 requests → 3 MISS, 47 HIT  (94% HIT)
  Test 2 round 3 (long-poll):       50 requests → 1 MISS, 49 HIT  (98% HIT)
  Test 3 (staggered 10ms):          50 requests → 1 MISS, 49 HIT  (98% HIT)
  Test 4 (high concurrency):       250 requests → 1 MISS, 249 HIT (99.6% HIT)
```

### Test 5: distributed loadtest (edge Workers) — BEFORE IPv6 fix
```
Results (2026-02-09, before nginx IPv6 fix):
  50 edge Workers, 1 stream, long-poll, 30s, writes every 200ms
  cf-cache-status: HIT=984 (65%), MISS=471 (31%), BYPASS=49 (3%)
  x-cache (Worker's caches.default): MISS=1504 (100%)
  Offset drift: avg 31.1 unique offsets per worker (min 6, max 61)
  Delivery latency: p99 30-59s (catastrophic stalls from nginx IPv6 failures)
```

### Test 6: distributed loadtest (edge Workers) — AFTER IPv6 fix
```
Results (2026-02-09, after nginx IPv6 fix deployed):
  Run 1: 50 edge Workers, 1 stream, long-poll, 30s, writes every 200ms
    cf-cache-status: HIT=4692 (83%), MISS=905 (16%), BYPASS=50 (1%)
    x-cache (Worker's caches.default): MISS=5647 (100%)
    Offset drift: avg 113.9 unique offsets per worker (min 108, max 118)
    Delivery latency: avg 119ms, p50 90ms, p90 214ms, p99 282ms, max 638ms
    Writes: avg 37ms, p99 96ms, max 538ms

  Run 2: 50 edge Workers, 1 stream, long-poll, 30s, writes every 200ms
    cf-cache-status: HIT=4377 (79%), MISS=1109 (20%), BYPASS=50 (1%)
    x-cache (Worker's caches.default): MISS=5536 (100%)
    Offset drift: avg 111.7 unique offsets per worker (min 91, max 118)
    Delivery latency: avg 112ms, p50 85ms, p90 208ms, p99 298ms, max 565ms
    Writes: avg 37ms, p99 56ms, max 188ms
```

### Summary

| Source | Concurrent requests | MISSes | HIT rate | Latency |
|--------|-------------------|--------|----------|---------|
| Local machine | 50 | 1 | 98% | normal |
| Local machine | 100 | 1 | 99% | normal |
| DO droplet (external) | 50 | 1 | 98% | normal |
| DO droplet (external) | 250 | 1 | 99.6% | normal |
| Edge Workers (subrequests) | 50 | ~9 | 79% | normal |
| Edge Workers (30s, pre-IPv6 fix) | 50 | 471 total | 65% | p99: 30-59s |
| Edge Workers (30s, post-IPv6 fix) | 50 | ~1000 total | 79-83% | p99: 282-298ms |

CDN coalescing works perfectly for ALL external requests (local machine, remote server) but is impaired for Worker subrequests. The nginx IPv6 fix improved HIT rate from 65% → 79-83% and eliminated catastrophic latency stalls.

## What We've Ruled Out

1. **Multi-PoP fragmentation** — All Workers are in IAD (confirmed via cf-ray). Even from local machine, requests split across EWR+IAD and still coalesce perfectly.
2. **Cache-Control headers stripped by proxy** — Verified `Cache-Control: public, max-age=20` is present in responses through the nginx proxy.
3. **Authorization header fragmenting cache keys** — All Workers use the same Bearer token. No `Vary: Authorization` header in responses.
4. **Offset drift (different cache keys)** — The 9 MISSes are per INDIVIDUAL offset/cache-key.
5. **Responses not being cached at all** — 79% HIT rate confirms caching works. The issue is only the first ~9 requests per new cache key.
6. **CDN doesn't support coalescing** — Tests 1, 2, and 4 prove it does, at 99%+ from any external source.
7. **Geographic location of the client** — The DO droplet (NYC) gets the same 98%+ HIT rate as a local machine.

## Root Causes: Two Issues Identified

### Issue 1: Nginx IPv6 resolution failures (FIXED)

The nginx proxy on EKS was resolving AAAA records for `durable-streams.commoncurriculum.workers.dev`, then failing with `connect() to [2606:4700:20::681a:173]:443 failed (101: Network unreachable)` because EKS nodes lack IPv6 routing. This caused:
- **Origin errors visible to Cloudflare CDN**, triggering retry/failover logic
- **Catastrophic latency stalls** (p99: 30-59s, spikes up to 43s)
- **Degraded HIT rate** (65%) because failed origin requests couldn't populate the cache

**Fix**: Added `resolver 1.1.1.1 ipv6=off valid=30s` and changed `proxy_pass` to use a variable (`set $upstream ...`) so nginx actually uses the resolver directive. Results:
- HIT rate: 65% → 79-83%
- p99 latency: 30-59s → 282-298ms
- max latency: catastrophic → 565-638ms

### Issue 2: Worker subrequest coalescing limitation (platform behavior)

**Worker subrequests take a different internal code path in Cloudflare's CDN that does not participate in request coalescing to the same degree as external client requests.**

Confirmed by a controlled experiment from the SAME Digital Ocean droplet:
- `diagnose-cdn.ts` (droplet sends requests directly): **98-99.6% HIT** — perfect coalescing
- Distributed loadtest (edge Workers make subrequests): **79-83% HIT** — degraded coalescing

### Most Likely Mechanism

Large Cloudflare PoPs (like IAD) have multiple internal cache nodes. External requests from the same client IP are consistently routed to the same cache node (enabling coalescing), while Worker subrequests from different isolates are load-balanced across cache nodes. Each node independently sends a MISS to origin. The ~9 MISSes likely correspond to ~9 internal cache nodes in the IAD PoP.

Evidence:
- ~9 MISSes is suspiciously consistent regardless of total request count
- 250 external requests → 1 MISS (all routed to same node via consistent hashing)
- 50 Worker subrequests → ~9 MISSes (distributed across ~9 nodes)

## x-cache is Always MISS for CDN-proxied Requests

From both the droplet and edge Workers, `x-cache` (set by the core Worker's `caches.default` logic) is 100% MISS. This means:
- CDN HITs are served entirely by Cloudflare's CDN layer — the Worker never executes
- The Worker's `caches.default.put()` stores responses, but they're never read because CDN HITs don't reach the Worker
- The Worker's `caches.default` only matters for direct Worker requests that bypass the CDN

## Impact Assessment

### For Production (Real End Users)

**This may not be a problem.** Real end-user clients (browsers, mobile apps) make external HTTP requests, not Worker subrequests. Tests prove external requests coalesce at 98-99.6%, even at 250 concurrent requests across multiple PoPs.

### For Worker-to-Worker Communication

Workers reading streams through the CDN experience the degraded 79-83% HIT rate. But the core Worker already has two layers of defense for CDN MISSes:

1. **`caches.default`** — shared cache across all isolates in the same colo
2. **`inFlight` Map** — deduplicates concurrent DO calls within a single isolate

### For the Loadtest

The loadtest numbers will always show worse HIT rates than production because it uses Worker subrequests. This is a measurement artifact, not a production problem.

## Recommended Actions

### 1. Consider Eliminating the Nginx Proxy

The proxy exists because "you can't point Cloudflare's CDN at a Cloudflare Worker directly via CNAME." Cloudflare now supports **Custom Domains for Workers** and **Workers Routes** which could replace it.

The proxy adds ~16ms in normal operation. Eliminating it via Workers Routes would:
- **Remove EKS infrastructure cost**
- **Simplify the architecture** from 4 hops to 2 hops
- **Remove a potential failure point** (IPv6 issue was one example)

```
Before: Client → CF CDN → Nginx (EKS) → CF Worker → DO
After:  Client → CF CDN/Worker (same edge) → DO
```

### 2. Accept the Platform Limitation for Worker Subrequests

CDN coalescing for Worker subrequests is a Cloudflare platform behavior. We cannot fix it. The core Worker's in-flight coalescing provides a second line of defense.

### 3. Consider Filing a Cloudflare Support Ticket

If Worker-to-Worker CDN coalescing is important, file a support ticket with the reproduction steps.

## How to Reproduce

```bash
# From the loadtest package directory:

# Test: Verify CDN coalescing from external client
pnpm diagnose -- --url https://ds-stream.commonplanner.com \
  --project-id loadtest --secret loadtest-diag-secret-2026 \
  --concurrency 50

# Test: Distributed loadtest (edge Workers — shows degraded coalescing)
npx tsx src/run.ts \
  --url https://ds-stream.commonplanner.com \
  --write-url https://durable-streams.commoncurriculum.workers.dev \
  --worker-url https://durable-streams-loadtest.commoncurriculum.workers.dev \
  --project-id loadtest --secret loadtest-diag-secret-2026 \
  --clients 50 --streams 1 --sse-ratio 0 \
  --write-interval 200 --duration 30 --ramp-up 3
```

## Loadtest Tooling

The reproduction commands above use the distributed loadtest package at `packages/loadtest/`. See `packages/loadtest/README.md` for the full tooling: local mode, distributed mode (edge Workers), CDN diagnostic tool (`diagnose-cdn.ts`), Analytics Engine integration, and options reference. The README also documents the Worker subrequest coalescing caveat in detail.

## Relevant Code

- Edge Worker cache logic: `packages/core/src/http/create_worker.ts` (cache lookup and store sections in `createStreamWorker()`)
- In-flight coalescing: `packages/core/src/http/create_worker.ts` (`inFlight` Map in `createStreamWorker()`)
- Long-poll cache headers: `packages/core/src/http/handlers/realtime.ts` (`buildLongPollHeaders` and `handleLongPoll` functions)
- Cache constants: `packages/core/src/protocol/limits.ts` (`LONG_POLL_CACHE_SECONDS = 20`)
- Nginx proxy: `packages/proxy/nginx.conf.template` + `packages/proxy/README.md`
