# CDN Cache Flow (Hot vs Cold Reads)

This document describes how the Worker/DO responds to hot (tail) vs cold (catch-up)
reads, and how CDN caching behaves in shared vs private cache modes.

Assumptions
- Stream ID: `doc-123`
- Worker endpoint: `/v1/stream/doc-123`
- Offsets are `readSeq_byteOffset` tokens.
- R2 holds immutable segments; DO SQLite holds the hot tail + segment index.

## Cache Mode Decision (Auth-Agnostic)
The Worker **decides** whether responses are safe to share across users and
forwards the decision to the DO via `X-Cache-Mode`:
- `shared` → CDN caching enabled where safe.
- `private` → DO forces `Cache-Control: private, no-store` on all reads.

How it is decided:
- `CACHE_MODE=shared|private` can be set to force the mode.
- Otherwise, your auth logic should decide and pass the correct mode.
- Default is **private** if nothing is specified.

## Mode A: Shared Cache (safe to share across users)

### Hot read (tail, long-poll)
Request
```
GET /v1/stream/doc-123?offset=0000000000000000_0000000000005000&live=long-poll&cursor=ab12
Authorization: Bearer <token>
```

Flow
- Worker authenticates.
- Worker normalizes cache key (URL only; `Authorization` is ignored).
- Worker sets `X-Cache-Mode: shared` on the DO request.
- Edge cache lookup via `caches.default`.
  - Cache hit: return cached response.
  - Cache miss: Worker -> DO -> SQLite hot tail.
- Response cached with short TTL (1–2s).

Example response
```
200 OK
Stream-Next-Offset: 0000000000000000_0000000000005005
Stream-Up-To-Date: 0
Stream-Cursor: ab13
Cache-Control: public, max-age=2
```

### Cold read (far behind)
Request
```
GET /v1/stream/doc-123?offset=0000000000000000_0000000000000200
Authorization: Bearer <token>
```

Flow
- Worker authenticates, normalizes cache key.
- Worker sets `X-Cache-Mode: shared`.
- Cache miss -> DO.
- DO reads R2 segment and returns response.
- CDN caches response longer (cold data is immutable).

Note: catch-up reads that hit the **hot tail** are marked `Cache-Control: private, no-store`
to avoid stale reads. Only R2-backed catch-up reads are cacheable.

Example response
```
200 OK
Stream-Next-Offset: 0000000000000001_0000000000000000
Stream-Up-To-Date: 0
Cache-Control: public, max-age=300
```

## Mode B: Private Cache (per-user / auth-fragmented)

### Hot read (tail, long-poll)
Request
```
GET /v1/stream/doc-123?offset=0000000000000000_0000000000005000&live=long-poll&cursor=ab12
Authorization: Bearer <user-specific>
```

Flow
- Worker authenticates.
- Worker sets `X-Cache-Mode: private`.
- Cache is private/no-store (or bypassed via `If-None-Match`).
- Cache miss -> DO -> SQLite hot tail (long-poll if needed).
- DO in-flight coalescing collapses identical reads.

Example response
```
200 OK
Stream-Next-Offset: 0000000000000000_0000000000005005
Stream-Up-To-Date: 0
Stream-Cursor: ab13
Cache-Control: private, no-store
```

### Cold read (far behind)
Request
```
GET /v1/stream/doc-123?offset=0000000000000000_0000000000000200
Authorization: Bearer <user-specific>
```

Flow
- Worker authenticates.
- Worker sets `X-Cache-Mode: private`.
- Cache is private/no-store.
- DO reads R2 segment and responds.

## Cache Key Notes
- Cache is only used for `GET`/`HEAD` without `If-None-Match`.
- `live=sse` is never cached.
- `Authorization` is never part of the cache key; auth happens first, then cache.

Example response
```
200 OK
Stream-Next-Offset: 0000000000000001_0000000000000000
Stream-Up-To-Date: 0
Cache-Control: private, no-store
```

## Summary

| Scenario | Cacheable? | Backend source | Why R2 matters |
| --- | --- | --- | --- |
| Hot read, shared | Yes (short TTL) | SQLite hot tail | CDN collapse, cheap |
| Cold read, shared | Yes (long TTL) | R2 segment | CDN + cheap cold storage |
| Hot read, private | No | SQLite hot tail | DO coalescing prevents herd |
| Cold read, private | No | R2 segment | Avoids hot log for history |
