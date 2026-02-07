# CDN Cache Architecture

## Edge Worker: Stateless Forwarder + Edge Cache

The edge worker (`create_worker.ts`) handles:

- **CORS** and **OPTIONS** preflight
- **Auth** (JWT verification, public stream bypass via KV)
- **Edge caching** via the Cloudflare Cache API (`caches.default`)
- **Routing** to the correct Durable Object (on cache miss)
- **KV metadata** on stream creation
- **Server-Timing** headers (when debug is enabled)

## Edge Cache (caches.default)

The edge worker uses the Cloudflare Cache API to cache immutable GET responses at the PoP level, avoiding DO round-trips for repeated reads of the same data.

**Requires a custom domain** — `caches.default` silently no-ops on `workers.dev` subdomains.

### What Gets Cached

Only **immutable mid-stream reads** are cached — responses where `Stream-Up-To-Date` is absent, meaning the data is behind the stream's tail. Data at a given offset never changes once written, so these responses are safe to cache with a long TTL.

| Request type | Cached? | Edge TTL | Client TTL | Notes |
|---|---|---|---|---|
| `GET ?offset=X` (mid-stream) | Yes | 300s | 60s (protocol) | Immutable — data at an offset never changes |
| `GET ?offset=X` (at tail, up-to-date) | No | — | 60s | Mutable — new data may arrive at this offset |
| `GET ?offset=X&live=long-poll&cursor=Y` (200, mid-stream) | Yes | 300s | 20s | Immutable data + cursor rotates cache key |
| `GET ?offset=X&live=long-poll` (200, at tail) | No | — | 20s | Mutable — could become stale |
| `GET ?offset=X&live=long-poll` (204 timeout) | No | — | — | Protocol: don't cache timeouts |
| `GET ?offset=now` | No | — | no-store | Cursor bootstrap, must be fresh |
| `GET ?live=sse` | No | — | — | Streaming, not cacheable |
| `HEAD` | No | — | — | Not a GET |
| `POST/PUT/DELETE` | No | — | — | Mutations |

### Why Only Immutable Responses

At-tail responses (`Stream-Up-To-Date: true`) can become stale when new data is appended. Since the Cache API doesn't support purging by URL prefix (only exact URL), we can't invalidate all offset-variant entries when a mutation occurs. Caching only immutable mid-stream data avoids serving stale data entirely.

### Edge TTL Override

The DO returns `Cache-Control: public, max-age=60` per the protocol (client-facing). Before `cache.put()`, the edge worker overrides `Cache-Control` on the response clone to `max-age=300` since the data is immutable. The original response to the client keeps the protocol-correct 60s.

### ETag Revalidation at the Edge

When a client sends `If-None-Match`:
1. Check edge cache for the URL
2. If cache hit AND cached ETag matches `If-None-Match` → return 304 (no DO call)
3. If cache hit AND ETags don't match → return cached response
4. If cache miss → forward to DO

### Long-Poll Collapsing

The protocol's cursor mechanism naturally enables request collapsing for mid-stream long-poll reads:
- Multiple clients at `?offset=100&live=long-poll&cursor=2000` share one cache entry
- When data arrives, the first request to miss cache hits the DO and stores the response
- Subsequent requests at the same offset+cursor get the cached response
- The cursor advances on each response, creating a new cache key → no infinite loops

At-tail long-poll responses are NOT cached (they're up-to-date), so long-poll collapsing only applies during catch-up reads.

### Per-Datacenter Cache

Each Cloudflare PoP builds its own cache organically from client traffic. A cached response in Dallas won't serve London.

## Cache-Control Headers (set by the DO)

The Durable Object sets protocol-correct `Cache-Control` headers on all read responses via `cacheControlFor()`:

| Scenario | Cache-Control | Why |
|----------|--------------|-----|
| Non-TTL stream (open or closed) | `public, max-age=60, stale-while-revalidate=300` | Protocol section 8: all catch-up reads are cacheable |
| TTL stream with time remaining | `public, max-age=min(60, remaining)` | Cache respects TTL expiry |
| Expired TTL stream | `no-store` | Content is gone |
| HEAD responses | `no-store` | Metadata-only, always fresh |
| `?offset=now` | `no-store` | Cursor bootstrap, must be fresh |
| Long-poll 200 | `public, max-age=20` | Short client TTL |
| Long-poll 204 (timeout) | `public, max-age=20` | Not cached at edge (only immutable 200s are stored) |
| SSE | `no-cache` | Real-time streaming |

## DO-Level Deduplication

The `ReadPath` class inside the DO coalesces concurrent reads:

- **In-flight dedup**: identical reads share a single storage call
- **Recent-read cache**: 100ms TTL, auto-invalidated by `meta.tail_offset` in the cache key (changes on every write)

This collapses bursts of identical requests at the DO level without risking stale reads.

## Summary

| Layer | Role |
|-------|------|
| Edge worker | Auth + CORS + edge cache + routing |
| Edge cache (caches.default) | Per-PoP cache for immutable mid-stream reads, ETag revalidation |
| Durable Object | Sets `Cache-Control` + `ETag` headers per protocol |
| ReadPath coalescing | DO-level request dedup (100ms, auto-invalidating) |
