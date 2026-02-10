# Chapter 12: CDN Reader Key

## Problem

There are two meanings of "public" in this system that must not be confused:

- **Public stream** (`?public=true`): a stream that skips auth entirely. Anyone can read it. This is a feature.
- **Public cache** (`Cache-Control: public`): an HTTP caching directive on **all** cached read responses, including auth-required streams. This tells the CDN to cache and serve the response to any requester.

The issue is the second one. Auth-required streams emit `Cache-Control: public, max-age=60` (catch-up reads) and `public, max-age=20` (long-poll reads). The CDN caches these and serves them to anyone who requests the URL — the request never reaches the worker, so JWT auth never runs.

If you know the URL pattern and offset, you can read cached data from an auth-required stream without any credentials:

```
curl https://streams.example.com/v1/stream/myproject/secret-stream?offset=100
```

The cache key is the bare URL. No auth info. The CDN can't distinguish authorized from unauthorized requests.

**Why the responses must stay `Cache-Control: public`:** The `public` directive enables CDN caching, which enables request collapsing — the core scaling mechanism. Switching to `private` or `no-store` would disable CDN caching and force every request to the worker, defeating the entire edge cache layer. We need the CDN to cache, but we need it to only serve authorized readers.

## Design: Per-Stream Shared Reader Key

A random opaque string generated per stream, shared by all authorized readers. The client includes it as a query parameter (`?rk=<key>`) on every read. Since it's part of the URL, it's automatically part of the CDN cache key. Without the correct `rk`, you can't construct a URL that matches any cached entry.

### Not an Auth Check

JWT auth is the single source of truth for authorization. The reader key is **not** a second auth layer. The worker does not validate `rk`. It's purely a cache gating mechanism:

- **CDN HIT**: the `rk` in the URL must match the `rk` in the cached entry's URL. Wrong/missing `rk` = different URL = no cache entry = MISS.
- **CDN MISS → worker**: JWT auth runs. If it passes, the response is served. The `rk` in the URL just ensures the cached response is keyed to an unguessable URL.

The only worker-side concern: don't store responses in the CDN cache when the URL is missing `rk` and the stream has a reader key. This prevents an authenticated client from accidentally populating a cache entry at the bare URL (without `rk`), which anyone could then hit.

### Why Per-Stream, Not Per-User

Per-user keys would fragment the cache: each user gets a different cache key, destroying request collapsing. Per-stream keys preserve collapsing: all authorized readers at the same offset share one cache entry. The key is a capability gate, not an identity marker.

### Request Flow

```
Client request: GET /v1/stream/proj/id?offset=100&rk=abc123&live=long-poll&cursor=xyz

CDN cache lookup: URL includes rk → unique to authorized readers
  ├─ HIT  → serve (rk was in the URL when this entry was first cached)
  └─ MISS → forward to worker
               │
               ├─ JWT auth — single source of truth, unchanged
               │
               └─ DO response → cache store (only if URL has rk) → return
```

Without `rk` in the URL:
```
CDN cache lookup: URL without rk → no matching entry → MISS → worker → JWT rejects → 401
```

### CDN Impact

None. All authorized readers use the same `rk`, so cache keys are identical for all readers at the same offset. Request collapsing is fully preserved: 1M readers → 1 DO hit per poll cycle. The `rk` is just an additional query parameter in the URL — the CDN treats it the same as `offset` or `cursor`.

### Storage

The KV `REGISTRY` already stores stream metadata at key `projectId/streamId`:

```json
{ "public": false, "content_type": "application/json", "created_at": 1234567890 }
```

Add `readerKey`:

```json
{ "public": false, "content_type": "application/json", "created_at": 1234567890, "readerKey": "rk_a1b2c3d4e5f6..." }
```

No new KV lookup — `isStreamPublic()` already reads this entry. Widen it to return the full metadata.

### Generation

On stream creation (PUT → 201) for auth-required streams, generate a reader key:

```ts
const readerKey = `rk_${crypto.randomUUID().replace(/-/g, "")}`;
```

Public streams (`?public=true`) don't get a reader key — anyone can read them.

### Distribution

How the client gets the reader key:

1. **HEAD response** (always `no-store`, always hits the worker): return `Stream-Reader-Key: <key>` header after JWT auth passes.
2. **PUT 201 response**: return `Stream-Reader-Key: <key>` to the stream creator.

Client workflow:
1. Authenticate (get JWT with read scope)
2. `HEAD /v1/stream/proj/id` → get `Stream-Reader-Key` header
3. Use `?rk=<key>` on all subsequent GET requests

### Cache Store Guard

In the edge worker's cache store logic, add one guard: if the stream has a `readerKey` in KV metadata and the request URL does not contain an `rk` param, skip `cache.put()`. This prevents populating cache entries at URLs that don't include the reader key.

This is not an auth check. It's a cache hygiene rule: "don't cache responses at guessable URLs for streams that have reader keys."

### Public Streams (`?public=true`)

Public streams skip JWT auth and skip the reader key. No reader key is generated, no `rk` is required. Anyone can read them, and their responses are cached normally.

### Rotation

Rotate the reader key to instantly invalidate all CDN-cached entries for a stream:

1. Generate new key, update KV metadata.
2. All existing cache entries are keyed with old `rk` → new requests use new `rk` = new URLs = all MISSes.
3. Clients call HEAD to get the new key, resume with new `rk`.

Exposed as an RPC method: `rotateReaderKey(doKey) → { readerKey: string }`.

### What Doesn't Change

- **Request collapsing**: all readers share the same `rk`, so cache keys are identical. 1M readers → 1 DO hit per poll cycle.
- **`Cache-Control: public`**: responses still say `public`. The CDN still caches. The `rk` in the URL is what prevents unauthorized access.
- **JWT auth**: single source of truth, unchanged. No second auth check.
- **SSE**: never cached, always hits worker, JWT auth runs. No `rk` needed.
- **`?offset=now`**: already `no-store`, never cached. No `rk` needed.

### Query Param vs. Header

Query param (`?rk=<key>`) because:
- Automatically part of the URL = automatically part of the CDN cache key
- Works with all CDN/proxy layers without `Vary` configuration
- No CDN configuration changes needed

Downside: reader key visible in URL logs. Acceptable — the key is per-stream (not per-user) and rotatable.
