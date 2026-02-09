# Chapter 5: Current Cache Architecture

The result of the Phase 1–4 evolution. This is the reference for what the edge cache does today.

## Edge Worker

The edge worker (`create_worker.ts`) sits between clients and the Durable Object. It handles:

| Concern | Details |
|---------|---------|
| **CORS** | `OPTIONS` preflight + origin headers on all responses |
| **Auth** | JWT verification, public stream bypass via KV |
| **Edge cache** | Cloudflare Cache API (`caches.default`) for mid-stream GETs and long-poll reads |
| **X-Cache header** | Always-on `X-Cache` response header on cacheable GETs: `HIT`, `MISS`, or `BYPASS` |
| **SSE bridge** | For `?live=sse`: opens an internal WebSocket to the DO, bridges WS messages to SSE events |
| **Routing** | Resolves DO stub from stream path, forwards request on cache miss |
| **KV metadata** | Stores public stream flags on creation |
| **Server-Timing** | Optional profiling headers when `DEBUG_TIMING=1` |

## Edge Cache (`caches.default`)

The edge worker caches GET 200 responses at the PoP level when the data is safe to cache: mid-stream reads (immutable data) and long-poll reads (cursor rotation prevents stale loops). Plain GET at-tail reads are NOT cached because new appends change the data, breaking read-after-write consistency. Staleness of cached entries is bounded by `max-age` which the DO sets per response type.

**Requires a custom domain** — `caches.default` silently no-ops on `workers.dev` subdomains.

### X-Cache Response Header

All cacheable GET responses include an `X-Cache` header indicating cache status:

| Value | Meaning |
|-------|---------|
| `HIT` | Served from edge cache (no DO round-trip) |
| `MISS` | Cache miss, response fetched from origin DO |
| `BYPASS` | Client sent `Cache-Control: no-cache` or `no-store`, skipped cache lookup |

Non-cacheable requests (SSE, debug, HEAD, mutations) do not include the header.

### What Gets Cached

GET 200 responses are cached unless the response is at-tail (for plain GETs) or has `Cache-Control: no-store`. The cache store guard is: `!cc.includes("no-store") && (!atTail || isLongPoll)`.

| Request type | Cached? | Edge TTL | Client TTL | Notes |
|---|---|---|---|---|
| `GET ?offset=X` (mid-stream) | Yes | 60s | 60s | Immutable data at a given offset never changes |
| `GET ?offset=X` (at tail) | No | — | 60s | Not stored; breaks read-after-write if cached |
| `GET ?offset=X&live=long-poll&cursor=Y` (mid-stream) | Yes | 20s | 20s | Immutable data, cursor rotates cache key |
| `GET ?offset=X&live=long-poll&cursor=Y` (at tail, 200) | Yes | 20s | 20s | Cursor rotation prevents stale loops |
| `GET ?offset=X&live=long-poll` (204 timeout) | No | — | — | Excluded by status check; prevents tight retry loops |
| `GET ?offset=now` | No | — | no-store | Cursor bootstrap, must be fresh |
| `GET ?live=sse` | No | — | — | Streaming via internal WS bridge |
| `HEAD` | No | — | — | Metadata-only |
| `POST` / `PUT` / `DELETE` | No | — | — | Mutations |

### Why Mid-Stream and Long-Poll Caching Is Safe

**Mid-stream reads**: Data at a given offset is immutable — once written, it never changes. Caching mid-stream reads is always safe. `max-age=60` bounds the staleness window, but the data is identical on every read.

**Long-poll reads**: The cursor rotates on every response, producing a different URL for the next request. Old cache entries are never reused. `max-age=20` bounds staleness within a single cycle. This enables request collapsing: 1M clients at the same offset share one cache entry, collapsing to a single DO hit per poll cycle.

**Plain GET at-tail reads are NOT cached**: When a client reads at the tail, new appends can arrive at any time, changing the data available at that offset. Caching these responses would break read-after-write consistency — a client appends data, then reads, and gets the stale cached response instead of the fresh data. The DO still sets `Cache-Control: public, max-age=60` (for client-side caching), but the edge does not store the response.

**204 timeout responses** are excluded by the `status === 200` check. Caching 204s would cause tight retry loops (instant cache hit → immediate retry → same cached 204).

### Edge TTL

The edge cache uses the DO's protocol-correct `Cache-Control` headers as-is — no override. Catch-up reads get `max-age=60`, long-poll reads get `max-age=20`. Since cached data is immutable, entries are simply re-cached on the next miss after expiry.

### ETag Revalidation at the Edge

When a client sends `If-None-Match`:

1. Check edge cache for the URL.
2. Cache hit + ETag matches `If-None-Match` → return **304** (no DO call).
3. Cache hit + ETags differ → return cached response.
4. Cache miss → forward to DO.

### Long-Poll Collapsing

The protocol's cursor mechanism enables request collapsing for all long-poll reads (both mid-stream and at-tail):

- Multiple clients at `?offset=100&live=long-poll&cursor=2000` share one cache entry.
- First cache miss hits the DO and stores the response. Subsequent requests get the cached response.
- The cursor advances on each response, creating a new cache key — no stale loops.

This is the primary scaling mechanism: 1M followers of a stream collapse to 1 DO hit per long-poll cycle.

### Cache Bypass

The edge cache is skipped (both lookup and store) for:

- **Debug requests** (`X-Debug-Coalesce` header) — these change the response format.
- **Client `Cache-Control: no-cache` or `no-store`** — skips lookup but still stores the fresh DO response.

### Per-Datacenter Cache

Each Cloudflare PoP builds its own cache organically from client traffic. A cached response in Dallas won't serve London.

## Cache-Control Headers (set by the DO)

The DO sets protocol-correct `Cache-Control` headers on all read responses:

| Scenario | Cache-Control | Why |
|----------|--------------|-----|
| Non-TTL stream (open or closed) | `public, max-age=60, stale-while-revalidate=300` | Protocol section 8: all catch-up reads are cacheable |
| TTL stream with time remaining | `public, max-age=min(60, remaining)` | Cache respects TTL expiry |
| Expired TTL stream | `no-store` | Content is gone |
| HEAD | `no-store` | Metadata-only, always fresh |
| `?offset=now` | `no-store` | Cursor bootstrap, must be fresh |
| Long-poll 200 | `public, max-age=20` | Short client TTL |
| Long-poll 204 (timeout) | `no-store` | Not cached at edge (excluded by status check); `no-store` prevents client-side caching too |
| SSE | `no-cache` | Real-time streaming |

## DO-Level Deduplication

The `ReadPath` class inside the DO coalesces concurrent reads:

- **In-flight dedup**: identical reads share a single storage call.
- **Recent-read cache**: 100ms TTL, auto-invalidated by `meta.tail_offset` in the cache key (changes on every write).

This collapses bursts of identical requests at the DO level without risking stale reads.

## Summary

```
Client ──> Edge Worker ──> [Edge Cache] ──> StreamDO ──> SQLite / R2
                │                              │
                │ (SSE)                        │ (writes)
                └── WS bridge ←── Hibernation API WebSockets
```

| Layer | Role |
|-------|------|
| Edge worker | Auth, CORS, edge cache, SSE-via-WebSocket bridge, routing |
| Edge cache (`caches.default`) | Per-PoP cache for mid-stream GETs and long-poll reads (at-tail plain GETs and no-store excluded), ETag revalidation |
| StreamDO | Sets `Cache-Control` + `ETag` headers per protocol |
| ReadPath coalescing | DO-level request dedup (100ms, auto-invalidating) |
