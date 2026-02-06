# CDN Cache Flow (Hot vs Cold Reads)

This document describes how the Worker/DO responds to hot (tail) vs cold (catch-up)
reads, and how CDN caching behaves.

Assumptions
- Stream ID: `doc-123`
- Worker endpoint: `/v1/myproject/stream/doc-123`
- Offsets are `readSeq_byteOffset` tokens.
- R2 holds immutable segments; DO SQLite holds the hot tail + segment index.

## Caching Behavior

All stream reads use shared caching — responses are cacheable across users.
Auth is checked first; the cache key uses the URL only (`Authorization` is not part
of the cache key). Public streams (created with `X-Stream-Public: true`) skip auth
entirely for reads.

### Hot read (tail, long-poll)
Request
```
GET /v1/myproject/stream/doc-123?offset=0000000000000000_0000000000005000&live=long-poll&cursor=ab12
Authorization: Bearer <jwt>
```

Flow
- Worker authenticates (JWT or public stream check).
- Worker normalizes cache key (URL only; `Authorization` is ignored).
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
GET /v1/myproject/stream/doc-123?offset=0000000000000000_0000000000000200
Authorization: Bearer <jwt>
```

Flow
- Worker authenticates, normalizes cache key.
- Cache miss -> DO.
- DO reads R2 segment and returns response.
- CDN caches response longer (cold data is immutable).

Note: catch-up reads that hit the **hot tail** are marked `Cache-Control: no-store`
to avoid stale reads. Only R2-backed catch-up reads are cacheable.

Example response
```
200 OK
Stream-Next-Offset: 0000000000000001_0000000000000000
Stream-Up-To-Date: 0
Cache-Control: public, max-age=300
```

## Cache Key Notes
- Cache is only used for `GET`/`HEAD` without `If-None-Match`.
- `live=sse` is never cached.
- `Authorization` is never part of the cache key; auth happens first, then cache.

## Summary

| Scenario | Cacheable? | Backend source | Why R2 matters |
| --- | --- | --- | --- |
| Hot read (tail) | Yes (short TTL) | SQLite hot tail | CDN collapse, cheap |
| Cold read (catch-up) | Yes (long TTL) | R2 segment | CDN + cheap cold storage |
| SSE | No | SQLite hot tail | Streaming, not cacheable |
