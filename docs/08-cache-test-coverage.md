# Chapter 8: Cache Test Coverage

For each item: find a test that would **break** if the behavior changed. Verdict: COVERED, WEAK, or MISSING.

## Sources of truth

- Chapter 5: Current Cache Architecture
- Chapter 6: Request Collapsing
- [Upstream PROTOCOL.md](https://raw.githubusercontent.com/durable-streams/durable-streams/refs/heads/main/PROTOCOL.md)

## Cache store policy

- [x] 1. Mid-stream GET reads ARE cached at the edge — COVERED `edge_cache.test.ts` "caches mid-stream GET reads"
- [x] 2. Plain GET at-tail reads are NOT cached — COVERED `edge_cache.test.ts` "does NOT cache plain GET at-tail reads"
- [x] 3. Long-poll at-tail 200 responses ARE cached — COVERED `edge_cache.test.ts` "caches long-poll at-tail 200 responses"
- [x] 4. Long-poll 204 timeout responses are NOT cached — COVERED `edge_cache.test.ts` "does NOT cache long-poll 204 timeout responses"
- [x] 5. `offset=now` responses are NOT cached — COVERED `edge_cache.test.ts` "does NOT cache offset=now responses"
- [x] 6. Expired TTL stream responses are NOT cached — COVERED `edge_cache.test.ts` "does NOT cache expired TTL stream responses"
- [x] 7. 404 and other error responses are NOT cached — COVERED `edge_cache.test.ts` "does NOT cache error responses (404)"
- [x] 8. SSE responses are NOT cached — COVERED `edge_cache.test.ts` "does NOT cache SSE responses" + "SSE responses have no X-Cache header (non-cacheable)"
- [x] 9. Debug requests (`X-Debug-Coalesce`) are NOT cached and don't contaminate cache for normal requests — COVERED `edge_cache.test.ts` "debug requests (X-Debug-Coalesce) are never cached"
- [x] 10. Client `Cache-Control: no-cache` skips cache lookup (BYPASS) but still stores the fresh DO response — COVERED `edge_cache.test.ts` "client Cache-Control: no-cache skips lookup but cache stays populated"
- [x] 11. Closed streams at tail are still NOT cached for plain GETs (even though data is immutable) — COVERED `edge_cache.test.ts` "does NOT cache closed stream plain GET at-tail reads"

## Read-after-write consistency

- [x] 12. After appending data, a plain GET at tail returns the NEW data, not stale cached data — COVERED `edge_cache.test.ts` "plain GET at tail returns new data after append, not stale cache"

## X-Cache header

- [x] 13. Cache hits return `X-Cache: HIT` — COVERED `edge_cache.test.ts` multiple tests
- [x] 14. Cache misses return `X-Cache: MISS` — COVERED `edge_cache.test.ts` multiple tests
- [x] 15. Client no-cache bypass returns `X-Cache: BYPASS` — COVERED `edge_cache.test.ts` "client Cache-Control: no-cache skips lookup but cache stays populated"
- [x] 16. Non-cacheable requests (SSE, debug, HEAD, mutations) have NO `X-Cache` header — COVERED `edge_cache.test.ts` "HEAD requests have no X-Cache header" + "POST/PUT/DELETE have no X-Cache header" + "does NOT cache SSE responses" + "debug requests..."
- [x] 17. ETag 304 revalidation from cache returns `X-Cache: HIT` — COVERED `edge_cache.test.ts` "ETag revalidation returns 304 from cache"

## Cursor rotation

- [x] 18. Cursor rotation produces a different URL (new cache key) each long-poll cycle — COVERED `edge_cache.test.ts` "long-poll cursor rotation creates new cache keys"
- [x] 19. Mid-stream long-poll reads are also cached (not just at-tail) — COVERED `edge_cache.test.ts` "caches mid-stream long-poll reads (not just at-tail)"

## Cache-Control headers

- [x] 20. Catch-up reads: `public, max-age=60, stale-while-revalidate=300` — COVERED `edge_cache.test.ts` "plain GET has max-age=60 with stale-while-revalidate"
- [x] 21. Long-poll 200: `public, max-age=20` — COVERED `edge_cache.test.ts` "long-poll 200 has max-age=20"
- [x] 22. Long-poll 204: `no-store` — COVERED `edge_cache.test.ts` "long-poll 204 timeout has no-store"
- [x] 23. `offset=now`: `no-store` — COVERED `edge_cache.test.ts` "does NOT cache offset=now responses" + `offset_now_cache_headers.test.ts`
- [x] 24. HEAD: `no-store` — COVERED `edge_cache.test.ts` "HEAD requests return Cache-Control: no-store"
- [x] 25. Expired TTL stream: `no-store` — COVERED `edge_cache.test.ts` "expired TTL stream returns Cache-Control: no-store"
- [x] 26. TTL stream with time remaining: `max-age` capped to remaining seconds — COVERED `edge_cache.test.ts` "TTL stream has max-age capped to remaining TTL"

## ETags

- [x] 27. ETags vary with stream closure status (ETag changes when stream closes) — COVERED `edge_cache.test.ts` "ETag changes when stream closes (varies with closure status)"

## SSE

- [x] 28. SSE connections close approximately every 60 seconds to enable edge collapsing — WEAK `edge_cache.test.ts` "SSE connections close after approximately 55 seconds..." (skipped: DO setTimeout doesn't reliably fire through the SSE-via-WS bridge in miniflare/local mode; unskip when testing against deployed worker)

## Cache body correctness

- [x] 29. Cached response body is identical to the original DO response body — COVERED `edge_cache.test.ts` "serves identical body from cache hit"
