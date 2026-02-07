# CDN Cache Architecture

## Edge Worker

The edge worker (`create_worker.ts`) sits between clients and the Durable Object. It handles:

| Concern | Details |
|---------|---------|
| **CORS** | `OPTIONS` preflight + origin headers on all responses |
| **Auth** | JWT verification, public stream bypass via KV |
| **Edge cache** | Cloudflare Cache API (`caches.default`) for immutable mid-stream reads |
| **SSE bridge** | For `?live=sse`: opens an internal WebSocket to the DO, bridges WS messages to SSE events |
| **Routing** | Resolves DO stub from stream path, forwards request on cache miss |
| **KV metadata** | Stores public stream flags on creation |
| **Server-Timing** | Optional profiling headers when `DEBUG_TIMING=1` |

## Edge Cache (`caches.default`)

The edge worker caches immutable GET responses at the PoP level, avoiding DO round-trips for repeated reads of the same data.

**Requires a custom domain** — `caches.default` silently no-ops on `workers.dev` subdomains.

### What Gets Cached

Only **immutable mid-stream reads** are cached — responses where `Stream-Up-To-Date` is absent, meaning the data is behind the stream's tail. Data at a given offset never changes once written, so these responses are safe to cache with a long TTL.

| Request type | Cached? | Edge TTL | Client TTL | Notes |
|---|---|---|---|---|
| `GET ?offset=X` (mid-stream) | Yes | 60s | 60s | Immutable data at a given offset never changes |
| `GET ?offset=X` (at tail) | No | — | 60s | New data may arrive at this offset |
| `GET ?offset=X&live=long-poll&cursor=Y` (mid-stream) | Yes | 20s | 20s | Immutable data, cursor rotates cache key |
| `GET ?offset=X&live=long-poll` (at tail) | No | — | 20s | Mutable |
| `GET ?offset=X&live=long-poll` (204 timeout) | No | — | — | Don't cache timeouts |
| `GET ?offset=now` | No | — | no-store | Cursor bootstrap, must be fresh |
| `GET ?live=sse` | No | — | — | Streaming via internal WS bridge |
| `HEAD` | No | — | — | Metadata-only |
| `POST` / `PUT` / `DELETE` | No | — | — | Mutations |

### Why Only Immutable Responses

At-tail responses (`Stream-Up-To-Date: true`) can become stale when new data is appended. The Cache API doesn't support purging by URL prefix (only exact URL), so we can't invalidate all offset-variant entries on mutation. Caching only immutable mid-stream data avoids serving stale data entirely.

### Edge TTL

The edge cache uses the DO's protocol-correct `Cache-Control` headers as-is — no override. Catch-up reads get `max-age=60`, long-poll reads get `max-age=20`. Since cached data is immutable, entries are simply re-cached on the next miss after expiry.

### ETag Revalidation at the Edge

When a client sends `If-None-Match`:

1. Check edge cache for the URL.
2. Cache hit + ETag matches `If-None-Match` → return **304** (no DO call).
3. Cache hit + ETags differ → return cached response.
4. Cache miss → forward to DO.

### Long-Poll Collapsing

The protocol's cursor mechanism naturally enables request collapsing for mid-stream long-poll reads:

- Multiple clients at `?offset=100&live=long-poll&cursor=2000` share one cache entry.
- First cache miss hits the DO and stores the response. Subsequent requests get the cached response.
- The cursor advances on each response, creating a new cache key — no infinite loops.

At-tail long-poll responses are NOT cached, so collapsing only applies during catch-up reads.

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
| Long-poll 204 (timeout) | `public, max-age=20` | Not cached at edge (only immutable 200s are stored) |
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
| Edge cache (`caches.default`) | Per-PoP cache for immutable mid-stream reads, ETag revalidation |
| StreamDO | Sets `Cache-Control` + `ETag` headers per protocol |
| ReadPath coalescing | DO-level request dedup (100ms, auto-invalidating) |
