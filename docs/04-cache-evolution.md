# Chapter 4: Cache Research and Strategy Evolution (Phases 1-4)

How the caching strategy evolved through four phases, from "cache everything" to the current design. Each phase was a response to problems discovered in the previous one.

## Initial Research Findings

Before implementing edge caching, we investigated how Cloudflare's cache layer interacts with Workers. These findings shaped every decision that followed.

**1. Workers ALWAYS execute on every request.** Cloudflare Workers run before the cache. `Cache-Control` headers do NOT cause Cloudflare to skip the Worker. To cache at the edge, the Worker must explicitly use `cache.put()` / `cache.match()`. The Worker is always in control.

**2. `public` vs `private` only matters downstream.** Since Workers always execute, `public` vs `private` only affects downstream caches (browser, proxies). There is no risk of cross-user cache leakage at the Cloudflare edge because auth runs in the Worker before cache lookup.

**3. Cache API requires a custom domain.** `caches.default` silently no-ops on `workers.dev` subdomains. Only Workers deployed to custom domains have functional cache operations.

**4. Cache is per-datacenter (colo).** Each Cloudflare PoP builds its own cache organically. A cached response in Dallas won't serve requests routed to London. Cache warming happens naturally from client traffic -- no global propagation. This has implications for request collapsing: the cache only collapses requests within a single colo.

## Phase 1: Cache everything (earliest)

Short TTL for hot-tail reads, long TTL for cold reads. All responses cached aggressively.

**Problem**: Mutations couldn't purge offset-variant cache entries, causing stale reads. A client would append data, then read, and get the old cached response. There was no way to invalidate the cache for a specific offset -- `caches.default` doesn't support pattern-based purging.

**Outcome**: Broken. Stale reads are unacceptable.

## Phase 2: Cache nothing (`6316451`)

Ripped out `caches.default` entirely. The edge worker became a stateless forwarder. Docs explicitly stated: *"It does **not** cache responses. There is no `caches.default` usage."* Relied on external CDN via Cloudflare Cache Rules.

**Problem**: Correct but no request collapsing at all. Every read hit the Durable Object. At fan-out scale (1M followers of a stream), this means 1M DO hits per long-poll cycle -- unacceptable.

**Outcome**: Functionally correct but doesn't scale.

## Phase 3: Cache immutable only (`c1968fd` -> `f336b40` -> `0c2de41`)

Re-added `caches.default` but **only** for mid-stream reads -- responses without the `Stream-Up-To-Date` header. At-tail reads were explicitly excluded, including long-poll at-tail. Docs at this point said: *"At-tail long-poll responses are NOT cached, so collapsing only applies during catch-up reads."*

The guard was `!wrapped.headers.has(HEADER_STREAM_UP_TO_DATE)` -- any response that said "you're at the tail" was excluded from the cache.

A TTL override (300s edge vs 60s client) was added then removed because it leaked to clients on cache hits -- `caches.default` returns the stored response including headers, so the overridden `Cache-Control` was visible to clients.

**Problem**: No collapsing for live-tail long-poll reads. The whole point of the system is fan-out -- many clients following the same stream in real time. If long-poll at-tail isn't cached, every follower hits the DO on every poll cycle. Request collapsing only helped during catch-up, which is the easy case.

**Outcome**: Correct but missed the primary use case.

## Phase 4: Cache immutable + long-poll at-tail (`d273f78` -> `77dc4e6`) -- current

**The big goal reversal.** Changed the guard from `!wrapped.headers.has(HEADER_STREAM_UP_TO_DATE)` (immutable only) to `(!atTail || isLongPoll)` (immutable + long-poll at-tail). Docs flipped from *"At-tail long-poll responses are NOT cached"* to *"At-tail long-poll responses ARE cached."*

### Why long-poll at-tail caching is safe

The cursor mechanism makes it work:

1. All clients at the same stream position share the same URL: `/v1/proj/stream/id?offset=1000&live=long-poll&cursor=abc123`
2. First request: cache miss, hits DO, waits for data, gets 200 response
3. Response is cached at the edge (keyed by full URL including cursor)
4. Remaining clients: cache hit, served from edge, never reach the DO
5. All clients advance to the next offset + cursor -> new URL -> new cache key
6. One request hits the DO, the rest hit cache. Repeat.

The cursor rotates on every response, so old cache entries are never reused. `max-age=20` bounds staleness within a single cycle.

### What's still NOT cached

For the authoritative reference of what gets cached, see Chapter 5 (Current Cache Architecture).

| Request type | Why not cached |
|---|---|
| Plain GET at-tail | Breaks read-after-write consistency -- append then read would return stale data |
| Long-poll 204 (timeout) | Excluded by `status === 200` check; caching would cause tight retry loops |
| `?offset=now` | `no-store` -- cursor bootstrap, must be fresh |
| SSE | Streaming via WebSocket bridge, not cacheable |
| HEAD | Metadata-only, `no-store` |

### Verification checklist (Phase 4 correctness)

Five critical items were verified when Phase 4 was implemented:

1. **Cursor rotates on every response** -- confirmed. The DO computes a new cursor for each response. Non-deterministic cursors were a bug that was later fixed (see Chapter 6).
2. **Cursor appears in the URL** -- confirmed. It's a query param (`&cursor=Y`), which is part of the `caches.default` key.
3. **Concurrent writers during a long-poll cycle** -- acceptable. If two writes happen, the first response gets cached. The second write's data is picked up on the next poll cycle. The protocol guarantees eventual delivery, not same-cycle delivery.
4. **`atTail` check uses `.get() === "true"`** -- confirmed. The DO always sets `Stream-Up-To-Date: true` (the string "true"), never other values.
5. **`isLongPoll` check uses original request URL** -- confirmed. The `url` object is derived from the incoming request before any DO processing.
