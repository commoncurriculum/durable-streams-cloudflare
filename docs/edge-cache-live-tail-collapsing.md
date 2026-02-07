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
