# Chapter 12: CDN Reader Key

## Problem

Read responses carry `Cache-Control: public, max-age=60` (catch-up) or `public, max-age=20` (long-poll). The CDN caches these and serves them to anyone who requests the URL. Auth only runs in the worker, which the CDN bypasses on cache hits.

If you know the URL pattern and offset, you can read cached stream data without auth:

```
curl https://streams.example.com/v1/myproject/stream/secret-stream?offset=100
```

The cache key is the bare URL. No auth info, no `Vary` header. The CDN can't distinguish authorized from unauthorized requests.

## Design: Per-Stream Shared Reader Key

A random opaque string generated per stream, shared by all authorized readers of that stream. The client includes it as a query parameter (`?rk=<key>`) on every read. Since it's part of the URL, it's automatically part of the CDN cache key.

### Why Per-Stream, Not Per-User

Per-user keys would fragment the cache: each user gets a different cache key, destroying request collapsing. Per-stream keys preserve collapsing: all authorized readers at the same offset share one cache entry. The key is a capability gate, not an identity marker.

### Request Flow

```
Client request: GET /v1/proj/stream/id?offset=100&rk=abc123&live=long-poll&cursor=xyz

CDN cache lookup: URL = ...?offset=100&rk=abc123&live=long-poll&cursor=xyz
  ├─ HIT  → serve (rk was validated when entry was first cached)
  └─ MISS → forward to worker
               │
               ├─ Auth check (JWT) — existing flow, unchanged
               ├─ Reader key check: rk param vs. stored key in KV
               │   ├─ Match    → continue to DO
               │   └─ Mismatch → 403
               │
               └─ DO response → cache store (URL includes rk) → return
```

Wrong `rk` = different URL = no matching cache entry = cache MISS = worker validates and rejects. The CDN validates implicitly via URL matching.

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

On stream creation (PUT → 201), generate a reader key and include it in the KV metadata:

```ts
const readerKey = `rk_${crypto.randomUUID().replace(/-/g, "")}`;
```

The `rk_` prefix makes reader keys greppable in logs and distinguishable from other tokens.

### Distribution

How the client gets the reader key:

1. **HEAD response** (always `no-store`, always hits the worker): return `Stream-Reader-Key: <key>` header after auth passes. This is the primary distribution path.
2. **PUT 201 response**: return `Stream-Reader-Key: <key>` to the stream creator.

Client workflow:
1. Authenticate (get JWT with read scope)
2. `HEAD /v1/proj/stream/id` → get `Stream-Reader-Key` header
3. Use `?rk=<key>` on all subsequent GET requests

### Validation in the Worker

On cache MISS for a non-public stream with `authorizeRead` configured:

1. Look up stream metadata from KV (already done by `isStreamPublic`)
2. If metadata has a `readerKey` and request has `rk` param: compare. Mismatch → 403.
3. If metadata has a `readerKey` and request has NO `rk` param: 403.
4. If metadata has NO `readerKey` (old stream, or feature not enabled): skip check. Backwards compatible.

### Public Streams

Public streams skip auth and skip the reader key check. No change needed.

### Rotation

Rotate the reader key to instantly invalidate all CDN-cached entries for a stream:

1. Generate new key, update KV metadata.
2. All existing cache entries are keyed with old `rk` value — new requests use new `rk` = new URLs = all MISSes.
3. Clients get 403 on next cache MISS, call HEAD to get new key, resume.

Exposed as an RPC method: `rotateReaderKey(doKey) → { readerKey: string }`.

### What Doesn't Change

- **Request collapsing**: all readers share the same `rk`, so the cache key is identical for all authorized readers at the same offset. 1M readers → 1 DO hit per poll cycle.
- **Cache-Control headers**: still `public, max-age=60/20`. The DO doesn't know about reader keys.
- **SSE**: never cached, always hits worker, auth runs normally. No `rk` needed.
- **Auth flow**: JWT auth is unchanged. Reader key is an additional check, not a replacement.
- **`?offset=now`**: already `no-store`, never cached. No `rk` needed.

### Query Param vs. Header

Query param (`?rk=<key>`) is chosen over a custom header because:
- Automatically part of the URL = automatically part of the CDN cache key
- Works with all CDN/proxy layers without `Vary` configuration
- Works with `EventSource` (SSE) which can't set custom headers (though SSE isn't cached anyway)

Downside: reader key visible in URL logs and referrer headers. Acceptable tradeoff — the key is per-stream (not per-user) and rotatable.
