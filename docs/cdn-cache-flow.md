# CDN Cache Flow (Hot vs Cold Reads)

This document describes how the Worker/DO responds to hot (tail) vs cold (catch‑up)
reads, and how CDN caching behaves in shared vs private auth modes.

Assumptions
- Stream ID: `doc-123`
- Worker endpoint: `/v1/stream/doc-123`
- Offsets are logical stream offsets (not byte ranges).
- R2 holds immutable snapshots/segments; D1 holds the hot tail + index.

## Mode A: Shared Cache (safe to share across users)

### Hot read (tail, long‑poll)
Request
```
GET /v1/stream/doc-123?offset=0000000000000000_0000000000005000&live=long-poll&cursor=ab12
Authorization: Bearer <token>
```

Flow
- Worker authenticates.
- Worker normalizes cache key (ignores auth token).
- CDN cache lookup.
  - Cache hit: return cached response.
  - Cache miss: Worker -> DO -> D1 tail.
- Response cached with short TTL.

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
- Cache miss -> DO.
- DO looks up R2 snapshot/segment + byte range, returns response.
- CDN caches response longer (cold data is immutable).

Example response
```
200 OK
Stream-Next-Offset: 0000000000000000_0000000000001200
Stream-Up-To-Date: 0
Cache-Control: public, max-age=300
```

## Mode B: Private Cache (per‑user / auth‑fragmented)

### Hot read (tail, long‑poll)
Request
```
GET /v1/stream/doc-123?offset=0000000000000000_0000000000005000&live=long-poll&cursor=ab12
Authorization: Bearer <user‑specific>
```

Flow
- Worker authenticates.
- Cache is private/no‑store (or cache key includes auth).
- Cache miss -> DO -> D1 tail (long‑poll if needed).
- DO in‑flight coalescing collapses identical reads.

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
Authorization: Bearer <user‑specific>
```

Flow
- Worker authenticates.
- Cache is private/no‑store.
- DO reads byte range from R2 snapshot/segment and responds.

Example response
```
200 OK
Stream-Next-Offset: 0000000000000000_0000000000001200
Stream-Up-To-Date: 0
Cache-Control: private, no-store
```

## Summary

| Scenario | Cacheable? | Backend source | Why R2 matters |
| --- | --- | --- | --- |
| Hot read, shared | Yes (short TTL) | D1 tail | CDN collapse, cheap |
| Cold read, shared | Yes (long TTL) | R2 snapshot | CDN + cheap cold storage |
| Hot read, private | No | D1 tail | DO coalescing prevents herd |
| Cold read, private | No | R2 snapshot | Avoids D1 full history |
