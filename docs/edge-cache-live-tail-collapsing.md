# Edge Cache: Request Collapsing

## Status: IMPLEMENTED

The edge cache in `create_worker.ts` caches GET 200 responses for mid-stream reads and long-poll reads. Plain GET at-tail reads are excluded to preserve read-after-write consistency. This enables request collapsing for long-poll reads — the primary scaling mechanism for fan-out.

### What Changed

An always-on `X-Cache` response header (`HIT`/`MISS`/`BYPASS`) was added to all cacheable GET responses, making cache behavior observable by tests and operators in any environment.

The cache store guards:

| Guard | What it excludes |
|-------|-----------------|
| `cacheable` (line 274) | SSE, debug requests, non-GET methods |
| `wrapped.status === 200` | 204 timeout responses (prevents tight-retry loops) |
| `!cc.includes("no-store")` | `offset=now` responses, expired streams |
| `!atTail \|\| isLongPoll` | Plain GET at-tail responses (breaks read-after-write if cached) |

### Why Plain GET At-Tail Is Not Cached

When a client reads at the tail of a stream, new appends can arrive at any time. If the response were cached, a subsequent read after an append would return stale data from the cache instead of the fresh data — breaking read-after-write consistency. This also breaks ETag behavior (the ETag changes when data arrives, but the cache would serve the old ETag) and delete+recreate semantics.

Long-poll at-tail reads are safe to cache because the cursor mechanism rotates the URL on every response, preventing stale cache reuse.

### Why Long-Poll Caching Is Safe

**Long-poll reads** (`?live=long-poll&cursor=Y`): The cursor rotates on every response, changing the URL for the next request. Old cache entries are never reused. `max-age=20` bounds staleness within a single cycle.

**204 timeout responses**: Excluded by `status === 200`. Caching 204s would cause tight retry loops (instant cache hit → immediate retry → same cached 204). The status check prevents this without any additional logic.

---

## Design Analysis (Reference)

The analysis below documents the original problem and the reasoning behind the fix. It remains useful as a design reference.

## How Long-Polling Works

A client following a live stream in long-poll mode makes requests like:

```
GET /v1/{project}/stream/{id}?offset=1000&live=long-poll&cursor=abc123
```

The DO handler (`packages/core/src/http/handlers/realtime.ts`, `handleLongPoll`):

1. Reads data at the requested offset
2. If data exists immediately, returns **200** with the data
3. If no data exists (client is at the tail), queues the client in `LongPollQueue` and waits up to 4 seconds (`LONG_POLL_TIMEOUT_MS`)
4. If data arrives during the wait, returns **200** with the data
5. If the wait times out with no data, returns **204** (no content)

All responses include:
- `Stream-Next-Offset` — where to read next
- `Stream-Cursor` — a rotated cursor for the next request
- `Cache-Control: public, max-age=20` (`LONG_POLL_CACHE_SECONDS`)
- At-tail responses also include `Stream-Up-To-Date: true`

The cursor rotates on every response. The client's next request uses the new cursor and new offset, producing a **different URL** — a naturally rotating cache key.

## Why the Cursor Mechanism Enables Collapsing

All clients following the same stream at the same position share the **same URL**:

```
/v1/proj/stream/id?offset=1000&live=long-poll&cursor=abc123
```

If 1M clients are all at offset 1000 with cursor `abc123`:

1. **First request**: cache miss, hits the DO, waits for data, gets 200 response
2. **Response is cached** at the edge (keyed by URL)
3. **Remaining 999,999 requests**: cache hit, served from edge, never reach the DO
4. All clients receive the same response, advance to offset 1050 with cursor `def456`
5. Next poll cycle: everyone requests `?offset=1050&cursor=def456` — new URL, new cache key
6. One request hits the DO, the rest hit cache. Repeat.

This collapses 1M requests per long-poll cycle into **1 DO hit**. The cursor rotation prevents stale loops — each response naturally invalidates the previous cache key by advancing the cursor.

## Architecture Reference

### File Map

| File | Role |
|------|------|
| `packages/core/src/http/create_worker.ts` | Edge worker: auth, cache lookup/store, routing to DO |
| `packages/core/src/http/handlers/realtime.ts` | Long-poll + SSE handlers inside the DO |
| `packages/core/src/http/handlers/read.ts` | Plain GET/HEAD handlers inside the DO |
| `packages/core/src/stream/read/path.ts` | DO-level read coalescing (in-flight dedup + 100ms cache) |
| `packages/core/src/protocol/expiry.ts` | `cacheControlFor()` — sets Cache-Control per stream TTL state |
| `packages/core/src/protocol/etag.ts` | `buildEtag()` — ETag format |
| `packages/core/src/protocol/limits.ts` | `LONG_POLL_TIMEOUT_MS` (4s), `LONG_POLL_CACHE_SECONDS` (20) |
| `packages/core/src/protocol/headers.ts` | `HEADER_STREAM_UP_TO_DATE` constant ("Stream-Up-To-Date") |

### Edge Cache Flow

```
Client request
  │
  ├─ OPTIONS/health → respond immediately
  │
  ├─ Auth check (JWT or public stream bypass via KV)
  │
  ├─ Cache lookup (GET only, not SSE, not debug)
  │   ├─ Hit + ETag match → 304
  │   ├─ Hit → return cached response
  │   └─ Miss → continue to DO
  │
  ├─ SSE → WebSocket bridge (never cached)
  │
  ├─ Route to DO via stub.routeStreamRequest()
  │
  └─ Cache store (GET 200, no no-store, !atTail || isLongPoll)
```

### Long-Poll Response Headers (set by DO)

For a 200 with data at the tail:
```
HTTP/1.1 200 OK
Content-Type: application/json
Stream-Next-Offset: <encoded>
Stream-Up-To-Date: true
Stream-Cursor: <rotated>
Cache-Control: public, max-age=20
ETag: "streamId:1000:1050:c"
```

For a 204 timeout:
```
HTTP/1.1 204 No Content
Stream-Next-Offset: <encoded>
Stream-Up-To-Date: true
Stream-Cursor: <rotated>
Cache-Control: public, max-age=20
```

## Edge Cases

### Conformance tests

The conformance test suite runs against a local wrangler worker via miniflare. Miniflare implements `caches.default` locally. Mid-stream GETs and long-poll reads are cached. At-tail plain GETs are not cached, preserving protocol correctness. Conformance tests use unique stream IDs per test, so cache entries don't interfere across tests.

### Client `Cache-Control: no-cache` bypass

The edge worker skips cache **lookup** but still **stores** the fresh response when the client sends `Cache-Control: no-cache`. This lets a client force a fresh read while still populating the cache for others.

### Closed streams at the tail

When a stream is closed, at-tail responses are truly immutable — no more data will ever be written. These are still excluded from the plain GET cache for simplicity (the guard checks `Stream-Up-To-Date` which is set for both open and closed at-tail reads). Long-poll at-tail reads of closed streams are cached normally via cursor rotation.

### TTL/expiring streams

Streams with `expires_at` get `max-age=min(60, remaining)`. If the stream expires while a cached at-tail response is still alive, clients receive valid data from an expired stream. The window is small (≤60s) and the data is correct.

### ETag inconsistency (pre-existing)

`buildReadResponse` in `read.ts` uses `params.meta.closed === 1` (global stream closed status) for the ETag closed flag. `handleLongPoll` in `realtime.ts` uses `closedAtTail` (whether this specific read reached the closed tail). They produce different ETags for the same byte range depending on the read path. Not a cache correctness issue since the URLs differ.

### `If-None-Match` multi-value (pre-existing)

The edge ETag revalidation does simple string equality. RFC 7232 allows comma-separated lists and `*`. Not a practical issue for this use case.

---

## Cross-Isolate Sentinel Coalescing

### Problem

The theoretical design (above) assumes that when 1,000 clients poll at the same offset+cursor, the first request populates the cache and the remaining 999 get cache HITs. In practice, Cloudflare Workers run **one isolate per concurrent request**. Each isolate has its own memory — in-memory dedup (Maps, Promises) cannot coalesce across isolates.

With 500 concurrent long-poll readers all waking up when a write occurs, all 500 isolates check `caches.default` simultaneously. The first isolate's `cache.put()` takes ~5-10ms to propagate. During that window, every other isolate also sees a cache MISS and makes its own DO connection. Result: **0% HIT rate** — the cache was useless.

### Three-Level Coalescing

The fix uses three layers of coalescing, each catching what the previous level misses:

**Level 1: Edge cache** (`caches.default.match`) — The first check. Instant for subsequent requests after a cache entry exists. Shared across all isolates in a Cloudflare colo.

**Level 2: In-memory Map** (`inFlight`) — Zero-overhead same-isolate coalescing. The `createStreamWorker()` factory is called at module scope (not per-request) so the Map is shared across requests in the same isolate. At scale (~1 request per isolate), this rarely fires, but it's free.

**Level 3: Cache sentinel** — Cross-isolate coalescing within a colo. The first cache-miss stores a short-lived sentinel marker in `caches.default`. Later arrivals find the sentinel and poll for the cached result instead of opening duplicate DO connections.

### Sentinel Pattern

When a long-poll request gets a cache MISS:

1. Check `caches.default` for a sentinel at `{cacheUrl}&__sentinel=1`
2. Apply small random jitter (0–`SENTINEL_JITTER_MS`) to spread simultaneous arrivals
3. Re-check sentinel after jitter
4. **If sentinel found** → another isolate is already fetching. Poll `caches.default.match(cacheUrl)` every `POLL_INTERVAL_MS` until the cached response appears (max `MAX_POLL_MS`). Return with `X-Cache: HIT`.
5. **If no sentinel** → we're the winner. Store sentinel (TTL = `SENTINEL_TTL_S`), proceed to DO.
6. Winner gets DO response, does **`await cache.put()`** (synchronous, not fire-and-forget) so polling isolates find the entry on their next poll cycle.
7. Winner cleans up sentinel after cache store. Error path also cleans up sentinel so a failed winner doesn't block retries.

### DO Stagger

When a write wakes long-poll waiters, resolving them all at once creates a thundering herd — all clients reconnect simultaneously, overwhelming the sentinel race window. The fix: resolve the first waiter immediately (the "scout") and spread the rest over a random `[0, LONGPOLL_STAGGER_MS]` window.

This gives the scout time to reach the edge, get a cache MISS, fetch from the DO, and store the response in `caches.default` before the bulk of reconnecting clients arrive. Combined with the sentinel pattern, stagger reduces the number of simultaneous arrivals during the critical race window.

`LONGPOLL_STAGGER_MS` is set in `packages/core/src/protocol/limits.ts`. The stagger happens inside the DO (before clients reconnect to the edge), so it adds no perceptible latency to the end-user — the data was just written and clients receive it within the stagger window.

### Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `SENTINEL_TTL_S` | 30s | Sentinel marker TTL in `caches.default` |
| `POLL_INTERVAL_MS` | 50ms | How often pollers check for the cached result |
| `MAX_POLL_MS` | 31,000ms | Polling timeout (slightly longer than long-poll DO timeout) |
| `SENTINEL_JITTER_MS` | 20ms | Random jitter before sentinel check to spread arrivals |
| `LONGPOLL_STAGGER_MS` | 100ms | DO-side stagger window for long-poll waiter resolution |

### The Sentinel Race Window

The sentinel check-then-set is **not atomic**. `await caches.default.put()` takes ~5-10ms to propagate across a colo. During this window, concurrent requests that check the sentinel find nothing and also become "winners" that hit the DO.

With N long-poll clients, J ms of jitter, and P ms of sentinel propagation delay:
- Requests spread uniformly over [0, J] ms
- Requests arriving in [0, P] miss the sentinel
- **Expected MISSes per write ≈ N × P / J**

Examples:
- 500 LP, P=10ms, J=20ms → ~250 MISSes (50%) — but polling recovers many
- 100 LP, P=10ms, J=20ms → ~50 MISSes (50%)
- 50 LP, P=10ms, J=20ms → ~25 MISSes (50%)

In practice, requests that miss the sentinel but arrive after the winner starts its DO round-trip will find the sentinel on their first poll check (within 50ms). The actual MISS rate is lower than the formula suggests because the sentinel propagates within the first few milliseconds and pollers find the cached result quickly.

### Approaches Tried and Rejected

**Probabilistic deferral** (reverted): 98% of requests voluntarily sleep for 300-500ms, letting 2% race for the sentinel. Achieved 84% HIT at 300ms defer, but added unacceptable latency for a real-time system. Every long-poll cycle was delayed by 300ms for most clients.

**Sentinel retention** (reverted): Keeping the sentinel alive (letting it expire via TTL instead of deleting after cache store). Showed no improvement — the race window occurs before the sentinel exists, not after it's deleted.

**Wider jitter** (50ms, 100ms — reverted): Tested jitter at 50ms and 100ms. At 100ms, improved low-follower (48 LP/stream) from 40% → 53% HIT, but regressed high-follower (476 LP/stream) from 86% → 77% HIT. At 50ms combined with stagger=100, showed no improvement over 20ms jitter. The low-follower improvement doesn't matter in absolute terms — 48 LP/stream with 50% MISS = ~24 DO connections per write, which is negligible load. 20ms jitter (avg 10ms added latency) is the right tradeoff.

**Stagger + wider jitter combo** (reverted): Tested stagger=100ms with jitter=50ms to see if benefits are additive. They are not — the combo showed the same 86% HIT rate as stagger=100ms alone. The stagger already spreads the reconnection burst enough that wider jitter provides no additional benefit.

**Longer stagger** (300ms, reverted): Tested stagger=300ms to give the scout more time to cache its response. Showed 85% HIT (high-follower) and 51% HIT (low-follower) — no improvement over 100ms, with diminishing returns as the added delay approaches the long-poll timeout.

**DO-side cache pre-warming** (implemented, marginal improvement): The DO stores the response in `caches.default` at each waiter's URL before resolving waiters. This bypasses the sentinel race window for clients in the DO's colo. Results: no improvement in high-follower (89% vs 90% baseline) but +13pp in low-follower (53% vs 40%). The improvement is limited because: (1) `caches.default.put()` from a DO only writes to the DO's colo cache — edge Workers in other colos don't see it; (2) with high concurrency, the sentinel still dominates the race window for non-local colos.

**Edge pre-warming** (implemented, no measurable improvement): After the sentinel-winning edge Worker caches a response, it fires a background long-poll for the NEXT URL (next offset + cursor). The idea is to have a cached response ready before clients reconnect. Results: no measurable improvement. The pre-warm long-polls for the next write, which arrives ~1s later. But clients reconnect within milliseconds of receiving the current response — by the time the pre-warm caches the next URL's response, all clients have already passed the cache check for that URL.

### Loadtest Results

All tests: 1 write/second, 120s duration, distributed across Cloudflare Workers.

#### Sentinel-Only Results (stagger=0, jitter=20ms)

| Config | LP/stream | HIT% | MISS% | p50 Latency | DO Reduction |
|--------|-----------|------|-------|-------------|--------------|
| Before sentinel (baseline) | ~500 | 0% | 98% | — | 1x |
| 1K clients, all-LP, 1 stream | ~922 | **87%** | 13% | 186ms | ~8x |
| 1K clients, 50/50 SSE/LP, 1 stream | ~476 | **86%** | 14% | 320ms | ~7x |
| 500 clients, 50/50, 1 stream | ~248 | **75%** | 24% | 280ms | ~4x |
| 1K clients, all-LP, 10 streams | ~93 | **61%** | 39% | 258ms | ~2.5x |
| 1K clients, 50/50, 10 streams | ~48 | **40%** | 59% | 121ms | ~1.7x |

#### DO Stagger Experiments (jitter=20ms unless noted)

| Stagger | Jitter | High-follower (1K LP, 1 str) HIT% | Low-follower (1K 50/50, 10 str) HIT% |
|---------|--------|-----------------------------------|--------------------------------------|
| 0 (baseline) | 20ms | 87% | 40% |
| 50ms | 20ms | 87% | 53% |
| **100ms** | **20ms** | **91%** | **55%** |
| 200ms | 20ms | 88% | 54% |
| 300ms | 20ms | 85% | 51% |
| 100ms | 50ms | 86% | 37% |

Stagger=100ms is the sweet spot: +4% on high-follower, +15% on low-follower. Wider jitter is not additive with stagger — the stagger already spreads reconnections enough. Longer stagger (200ms, 300ms) shows diminishing returns.

#### DO Pre-Cache + Edge Pre-Warming (stagger=100ms, jitter=20ms)

Both approaches layered on top of sentinel coalescing + stagger:

| Config | LP/stream | HIT% | Baseline HIT% | Delta |
|--------|-----------|------|---------------|-------|
| 1K clients, all-LP, 1 stream | ~1000 | **89%** | 90% | -1pp (noise) |
| 1K clients, 50/50, 10 streams (134 failed) | ~37 | **53%** | 40% | **+13pp** |

The DO pre-cache shows meaningful improvement in the low-follower scenario: with fewer clients per stream, a larger fraction of readers are in the DO's colo and benefit from the pre-cached response. In the high-follower scenario, the sentinel race window still dominates for non-local colos.

Edge pre-warming shows no measurable improvement in either scenario — the pre-warm races with clients for the same write. By the time write N+1 arrives (~1s later) and the pre-warm caches, all clients from write N have already reconnected and passed the cache check.

**Key observations:**

1. **HIT rate scales with LP clients per stream.** More readers sharing a cache key → more benefit from sentinel coalescing. At 1M readers per stream, expected HIT rate approaches 99.99%.

2. **SSE connections don't use the cache.** SSE uses a persistent WebSocket bridge — no repeated HTTP requests, no caching. The `(none)` entries in X-Cache stats are SSE connections.

3. **The sentinel race window is the bottleneck.** ~100-130 MISSes per write with 500+ LP clients, regardless of strategy. This is the ~5-10ms window where `caches.default.put()` hasn't propagated yet.

4. **DO stagger is the most effective lever.** Spreading waiter resolution over 100ms gives the scout time to cache its response before the bulk of reconnections arrive. Unlike client-side delays, the stagger adds no perceptible user-facing latency — it happens inside the DO's long-poll wait.

5. **No artificial client delays.** All latency is natural DO round-trip + cache propagation. The only added delay is 0-20ms sentinel jitter (average 10ms) + 0-100ms DO stagger (server-side, invisible to clients).

---

## WebSocket Cache Bridge

### Problem with Previous Approaches

All previous approaches (sentinel coalescing, DO stagger, DO pre-cache, edge pre-warming) share a fundamental limitation: **edge workers long-poll the DO directly**. When data arrives, the DO responds to each waiting edge worker individually. This means N concurrent readers = N DO connections, even though they all get the same data.

The sentinel pattern reduces this by coalescing most readers behind a cache poll, but the sentinel race window still lets ~100-130 edge workers through to the DO per write. And the DO pre-cache is always "one step behind" — it caches at URLs for clients already inside the DO.

### Architecture: DO Pushes, Edge Caches, Long-Poll Never Hits the DO

The SSE bridge already follows this pattern: one WebSocket to the DO, data pushed on writes, forwarded to SSE clients. The WebSocket cache bridge extends this to long-poll:

```
Previous:
  Long-poll client → edge → cache MISS → HTTP long-poll to DO → DO responds → edge caches

New:
  Bridge worker ←——WebSocket——→ DO  (persistent, pushes on every write)
  Bridge worker → caches.default.put()  (on every push)
  Long-poll client → edge → cache HIT → immediate response
```

The sentinel winner opens a persistent WebSocket to the DO (same mechanism as the SSE bridge). Instead of making a one-shot HTTP long-poll, the WebSocket stays alive for ~25 seconds via `ctx.waitUntil()`. On each write, the DO pushes data over the WebSocket. The bridge constructs a cacheable HTTP response and stores it in `caches.default`.

### How It Works

**Bridge lifecycle:**
1. First long-poll cache-miss in a colo → sentinel check → no sentinel → become bridge
2. Bridge opens WebSocket to DO via `stub.fetch()` with `live=ws-internal`
3. DO sends catch-up data (if client is behind) or `upToDate` control message
4. Bridge returns first data as HTTP response to its own long-poll client
5. Edge worker caches this response (existing cache store logic)
6. Bridge continues running in `ctx.waitUntil()` for ~25 seconds
7. On each subsequent write push from DO:
   - Bridge constructs cache URL from the PREVIOUS response's next-offset + cursor
   - Bridge builds HTTP response from the WebSocket data+control messages
   - Bridge calls `await caches.default.put()` at that URL
   - Bridge sets proactive sentinels at the NEXT expected URL
8. Bridge dies after ~25s. Next cache-miss client becomes the new bridge.

**Proactive sentinels:**
After caching each response, the bridge sets a sentinel at the NEXT URL clients will request. When those clients reconnect at the edge, they find the sentinel immediately — no race window. When the next write arrives, the bridge caches the response and pollers find it.

**Cursor coverage:**
The bridge caches at both active cursor intervals (`currentInterval` and `currentInterval + 1`) to cover clients that received their previous response at different times within the 20-second cursor window.

### Expected Behavior

With 500 concurrent long-poll clients in one colo, 1 write/sec:

- **T=0**: Write N arrives. Bridge caches response. Sets sentinels at next URLs.
- **T=0+stagger**: Long-poll clients reconnect. Cache HIT (bridge cached it). ~0 DO connections.
- **T=1s**: Write N+1 arrives. Bridge receives push, caches response. Sets sentinels.
- **T=1s+stagger**: Clients reconnect. Cache HIT again.

**Expected: ~100% cache HIT** in the bridge's colo. Each colo has its own bridge (via sentinel pattern). The DO sends 1 WebSocket message per colo per write (not per client).

For high-frequency writes (10/sec): the bridge receives 10 WS messages/sec, caches each immediately. No "double long-poll" — the bridge persists across writes.

### Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `BRIDGE_TIMEOUT_MS` | 6,000ms | Max wait for first data on bridge WebSocket |
| `BRIDGE_BG_LIFETIME_MS` | 25,000ms | How long bridge populates cache after returning initial response |

### Key Files

| File | Change |
|------|--------|
| `packages/core/src/http/create_worker.ts` | `bridgeLongPollViaWebSocket()` function + sentinel winner uses bridge for long-poll |
| `packages/core/src/http/handlers/realtime.ts` | `handleWsUpgrade` includes Content-Type in 101 response |

---

### Key Learnings

1. **`WorkerEntrypoint` is per-request, not singleton.** State in instance fields is NOT shared across requests. Module-scope variables ARE shared within an isolate.

2. **Cloudflare distributes ~1 isolate per concurrent request.** In-memory coordination cannot coalesce across isolates. Only `caches.default` (shared within a colo) works cross-isolate.

3. **`ctx.waitUntil(cache.put)` is fire-and-forget.** The cache entry may not be available when concurrent requests check. Use `await cache.put` when timing matters for coordination.

4. **Cursor must be deterministic.** The response cursor is derived from the request state. Non-deterministic cursors produce different cache URLs for identical requests, defeating collapsing entirely. (This was a Phase 1 bug that produced 0% HIT.)

5. **SSE WebSocket bridge must not recompute cursors.** The bridge constructs SSE control events directly from WebSocket message fields. Calling `buildSseControlEvent()` (which internally calls `generateResponseCursor()`) would double-process the cursor and produce different values.
