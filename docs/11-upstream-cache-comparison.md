# Chapter 11: Upstream Cache Proposal Comparison

Comparison of the upstream Durable Streams caching proposals ([#58](https://github.com/durable-streams/durable-streams/issues/58), [#60](https://github.com/durable-streams/durable-streams/issues/60), [#62](https://github.com/durable-streams/durable-streams/issues/62)) against our Cloudflare-native implementation. Written February 2026.

## Context

The upstream issues propose a comprehensive caching strategy modeled on [Electric SQL's approach](https://github.com/electric-sql/electric/blob/main/packages/sync-service/lib/electric/shapes/api/response.ex): tiered Cache-Control headers, ETag cache-busters, cursor-based loop prevention, CDN cache tags, and purge APIs. The proposals assume a generic HTTP server sitting behind external CDNs (Fastly, Cloudflare CDN, CloudFront, Vercel).

Our implementation is Cloudflare-native — the Worker controls its own edge cache via `caches.default`, making many of the upstream proposals either already solved or architecturally irrelevant.

## Summary

| Upstream Feature | Our Status | Action Needed? |
|---|---|---|
| Tiered Cache-Control headers | Implemented (different values, appropriate for CF) | No |
| Configurable cache TTLs | Hardcoded but correct | Optional |
| ETags + If-None-Match → 304 | Implemented | No |
| Monotonic ETag for empty responses | Not needed (204s excluded at edge) | No |
| Cursor-based cache key rotation | Implemented (`Stream-Cursor`) | No |
| Edge request collapsing | Implemented (CF CDN native + cursor rotation) | No |
| CDN cache tags (Surrogate-Key, Cache-Tag) | Not implemented | No |
| CDN purge API | Not implemented | No |
| `surrogate-control` on errors | Not implemented | No |
| Client-side caching guidance | Not documented | Low priority |

---

## 1. Cache-Control Headers (#60)

### Upstream proposal

A tiered system based on Electric:

| Request type | Proposed header |
|---|---|
| Initial snapshot (offset=-1) | `public, max-age=604800, s-maxage=3600, stale-while-revalidate=2629746` |
| Live requests | `public, max-age=5, stale-while-revalidate=5` |
| Incremental reads | `public, max-age=60, stale-while-revalidate=300` |
| Mutations | `no-cache` |
| Errors | `no-store` + `surrogate-control: no-store` |

### What we have

| Request type | Our header |
|---|---|
| Catch-up reads (non-TTL) | `public, max-age=60, stale-while-revalidate=300` |
| Catch-up reads (TTL stream) | `public, max-age=min(60, remaining)` |
| Long-poll 200 | `public, max-age=20` |
| `?offset=now` | `no-store` |
| Expired TTL stream | `no-store` |
| HEAD | `no-store` |
| SSE | `no-cache` |

### Key differences

**No `s-maxage` split.** Upstream uses different TTLs for edge vs browser (e.g., 1-week browser / 1-hour edge for snapshots). We use the same TTL for both. This is correct because our Worker controls the edge cache directly via `caches.default` — `s-maxage` is irrelevant when you're calling `cache.put()` yourself. The `Cache-Control` headers we emit are really just for downstream/browser caching.

**No 1-week snapshot TTL.** Upstream caches initial reads aggressively (7 days browser, 1 hour edge). Our catch-up reads use 60s + 5-minute stale-while-revalidate. This is more conservative but also more correct for our model — stream data at a given offset is immutable, so `max-age=60` is already safe. The 60s is a freshness bound, not a correctness bound. We could bump this for mid-stream reads to reduce browser re-fetches, but there's no pressing reason to.

**No `surrogate-control: no-store` on errors.** This header prevents CDN edge caches from caching error responses. Since our Worker handles its own edge caching and only stores 200s, this doesn't apply. It would only matter if an external CDN sat in front of our Worker.

**Live request TTL.** Upstream uses `max-age=5` for live. We use `max-age=20` for long-poll. The 20s aligns with our cursor rotation interval — it bounds staleness within one long-poll cycle.

### Verdict

Our headers are correct for our architecture. The upstream issue is designed for a generic HTTP server that relies on external CDNs. We have a Cloudflare-native implementation that handles caching in the Worker itself. The differences are by design.

---

## 2. Cursor / Infinite Loop Prevention (#58 Phase 3)

### Upstream proposal

An `electric-cursor` header with time-interval-based cursors to prevent infinite CDN cache loops on live requests. Plus monotonic-time ETags for empty responses:

```
# Normal ETag
"{shape-handle}:{offset}:{actual-offset}"

# Empty response ETag (cache-buster)
"{shape-handle}:{offset}:{actual-offset}:{monotonic-time}"
```

The cursor divides time into intervals (default 20s). Each interval produces a different cursor → different URL → different cache entry. This breaks the loop where empty live responses get cached and served indefinitely.

### What we have

A `Stream-Cursor` header that rotates on every response, included as a query parameter (`?cursor=Y`). Deterministic cursor derivation (offset + time interval) so all clients at the same position get the same cursor → same URL → cache sharing.

### Why the monotonic ETag isn't needed

Electric needs the monotonic-time ETag because their CDN might cache an empty response. We **don't cache 204 timeout responses at all** — the `status === 200` guard at the edge prevents it. The problem is avoided at the cache-store level rather than worked around with ETags.

### Verdict

Already solved, and arguably more cleanly. Our cursor mechanism is functionally equivalent to Electric's `electric-cursor` but integrated into the protocol. The infinite-loop prevention is handled by not caching 204s, not by making their ETags unique.

---

## 3. ETags and Conditional Requests (#58 Phase 2)

### Upstream proposal

ETag generation, `If-None-Match` support, 304 responses.

### What we have

All of it. The DO sets ETags (format: `"streamId:offset:actualOffset:closedFlag"`). The edge worker does ETag revalidation:

1. Check edge cache for the URL
2. Cache hit + ETag matches `If-None-Match` → **304** (no DO call)
3. Cache hit + ETags differ → return cached response
4. Cache miss → forward to DO

Two known minor issues (pre-existing, not correctness problems):
- ETag closed flag differs between read path (`params.meta.closed === 1`) and long-poll path (`closedAtTail`). Not a cache issue since URLs differ.
- `If-None-Match` uses simple string equality, not RFC 7232 comma-separated list parsing. Not a practical issue.

### Verdict

Already implemented.

---

## 4. CDN Cache Tags / Purging (#62)

### Upstream proposal

`Surrogate-Key` (Fastly), `Cache-Tag` (Cloudflare Enterprise), and purge APIs triggered on stream deletion/truncation.

### Why this doesn't apply

Kyle's own comment on #62: *"This is implementation specific not really relevant to the protocol."*

For our architecture specifically:

- **Cloudflare `Cache-Tag` is Enterprise-only.** Unless we're on an Enterprise plan, this header is ignored.
- **`caches.default` doesn't support tag-based purging.** We'd need the zone-level purge API, which requires Enterprise.
- **Our cache entries are short-lived.** 60s for catch-up, 20s for long-poll. Stale data self-evicts quickly. Explicit purging provides marginal benefit when entries live for 20–60 seconds.
- **Stream deletion already works.** When a stream is deleted, the DO stops responding. Cache entries expire within their TTL (≤60s). There's no user-visible stale window worth optimizing.

### When this would matter

If we ever moved to long TTLs (like the 1-week snapshot TTL in #60), cache purging becomes important — a deleted stream's snapshot would be served for up to a week. But that's a future concern, and it would come with a design change to use long TTLs.

### Verdict

Not relevant. Short TTLs and cursor rotation make tag-based purging unnecessary.

---

## 5. Configurable Cache TTLs (#60)

### Upstream proposal

```typescript
export interface CacheConfig {
  enabled: boolean;
  initialRead: { maxAge: number; sMaxAge: number; staleAge: number };
  incrementalRead: { maxAge: number; staleAge: number };
  liveRequest: { maxAge: number; staleAge: number };
}
```

### What we have

Hardcoded constants in `packages/core/src/protocol/limits.ts` and `packages/core/src/protocol/expiry.ts`.

### Assessment

The one potentially useful idea from the upstream issues. Making cache TTLs configurable via `createStreamWorker()` options would let library consumers tune `max-age` for their use case (e.g., longer TTLs for read-heavy streams with infrequent writes, shorter TTLs for high-write-frequency streams). The current hardcoded values are correct and well-reasoned, so this is a nice-to-have, not a gap.

---

## Architectural Difference: Why Our Approach Diverges

The fundamental difference is **where caching happens**.

**Upstream model (Electric, generic HTTP):**
```
Client → External CDN (Fastly/CF/CloudFront) → Origin Server
         ↑ cache-control headers control this
```
The origin server can only influence caching through HTTP headers. It has no direct control over what the CDN stores, when it evicts, or how it coalesces requests. Hence the need for cache tags, purge APIs, surrogate-control headers, and defensive ETag patterns.

**Our model (Cloudflare Workers + caches.default):**
```
Client → Edge Worker → [caches.default] → Durable Object
         ↑ Worker code controls this directly
```
The Worker runs on every request, before any caching. It explicitly calls `cache.match()` and `cache.put()` with full control over store guards (`status === 200`, `!atTail || isLongPoll`, `!no-store`). There is no external CDN to configure or coordinate with — the Worker *is* the edge cache controller.

This means:
- `s-maxage` is irrelevant (Worker controls edge TTL via `cache.put()`)
- `surrogate-control` is irrelevant (Worker decides what to store)
- Cache tags are irrelevant (Worker decides what to serve)
- Purge APIs are unnecessary (short TTLs + Worker control = natural eviction)
- Infinite-loop prevention is simpler (don't store 204s, done)

The `Cache-Control` headers we set on responses are for **downstream consumers only** (browsers, intermediate proxies) — not for our own edge caching logic.

---

## References

- Upstream issues: [#58](https://github.com/durable-streams/durable-streams/issues/58), [#60](https://github.com/durable-streams/durable-streams/issues/60), [#62](https://github.com/durable-streams/durable-streams/issues/62)
- Electric's implementation: [response.ex](https://github.com/electric-sql/electric/blob/main/packages/sync-service/lib/electric/shapes/api/response.ex), [utils.ex](https://github.com/electric-sql/electric/blob/main/packages/sync-service/lib/electric/plug/utils.ex)
- Our cache architecture: [05-cache-architecture.md](05-cache-architecture.md)
- Our cache evolution: [04-cache-evolution.md](04-cache-evolution.md)
- Our request collapsing: [06-request-collapsing.md](06-request-collapsing.md)
- Our CDN investigation: [07-cdn-miss-investigation.md](07-cdn-miss-investigation.md)
