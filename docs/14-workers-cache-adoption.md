# Chapter 14: Adopting Workers Cache (Native Cache in Front of the Worker)

**Status: PROPOSED.** Scope: replace the nginx dummy origin with Cloudflare's native
[Workers Cache](https://blog.cloudflare.com/workers-cache/) (announced July 2026). No changes
to auth, protocol, response headers, or the worker's internal cache/coalesce code.

This chapter supersedes the earlier re-architecture proposal (PR #46), which coupled the
adoption to a gateway/entrypoint split and a frame-addressed read model. Those are not
required to adopt the feature and are out of scope here.

## What Workers Cache Is

A Worker-owned HTTP cache that sits **in front of** the Worker entrypoint. Enabled in wrangler
config:

```toml
[cache]
enabled = true
```

Confirmed facts from the [Workers Cache docs](https://developers.cloudflare.com/workers/cache/):

- On a cache HIT, **the Worker does not execute**. Only `GET`/`HEAD` responses are cached;
  cacheability is governed by the response's standard `Cache-Control` directives per RFC 9111
  (`max-age`, `stale-while-revalidate`, `no-store`, `Vary`, ETag revalidation).
- **Request collapsing**: concurrent requests for the same cache key take a per-key lock;
  the Worker runs once and the response is served to all waiters. Tiered (cross-colo) caching
  is included.
- Works on **`workers.dev`, custom domains, and service bindings** — no external origin
  required. This is the capability that previously did not exist and forced the nginx proxy
  into the path (Chapters 2, 4, 7).
- The cache key is the path + full query string (plus Worker version by default;
  `cache.cross_version_cache` controls sharing across deploys). Our `offset`/`cursor`/`rk`
  keying carries over unchanged.
- Requires wrangler ≥ **4.69.0** (repo is at `^4.66.0` — needs a minor bump). No
  `compatibility_date` change is documented as required.
- Purge: `ctx.cache.purge()` and `Cache-Tag` headers (not needed for this adoption; cursor
  rotation and short TTLs remain our invalidation story).

## The Change

Today (Chapter 7):

```
Client → Cloudflare CDN (ds-stream.commonplanner.com, orange-cloud)
       → nginx dummy origin (EKS/k8s)
       → Worker → DO
```

After:

```
Client → Workers Cache → Worker → DO
         (ds-stream.commonplanner.com as a Workers Custom Domain)
```

Steps:

1. Bump wrangler to ≥ 4.69.0 in `packages/server`.
2. Add `[cache] enabled = true` to `packages/server/wrangler.toml`.
3. Move `ds-stream.commonplanner.com` from a CNAME-to-nginx to a Workers Custom Domain on the
   `durable-streams` worker.
4. Decommission `packages/proxy` and the EKS deployment.

Nothing inside `src/` changes. The response-header protocol (`cacheControlFor`, `no-store` on
HEAD/`offset=now`/SSE, ETag, cursor rotation, the `rk` reader-key URL scheme from Chapter 12)
was designed for a standards-following shared cache and is exactly what Workers Cache consumes.

## The One Real Behavior Difference: `Authorization` → BYPASS

This is the load-bearing finding, and it cuts against treating the native cache as a drop-in
for the zone CDN on **auth-required streams**.

- **Zone CDN today**: a request carrying `Authorization` is still served from / stored in
  cache when the response includes `public`, `s-maxage`, or `must-revalidate`
  ([Origin Cache Control conditions](https://developers.cloudflare.com/cache/concepts/cache-control/)).
  Our read responses say `public, max-age=…`, so authenticated reads get CDN HITs. Chapter 7's
  loadtests confirm this empirically — every request carried the same `Bearer` token and hit
  98–99%.
- **Workers Cache**: the bypass **fires on the inbound request, not on the response**. Per the
  [examples doc](https://developers.cloudflare.com/workers/cache/examples/): "an
  `Authorization` header on the forwarded request will turn every inner call into a `BYPASS`,
  and nothing will ever be stored" — `Cache-Control: public` does **not** rescue it.

Consequences by stream class:

| Stream class | Request shape | Zone CDN today | Workers Cache after |
|---|---|---|---|
| Public (`?public=true`) | GET, no `Authorization` | HIT/collapse at CDN | HIT/collapse at native cache (+ tiered) |
| Auth-required | GET with `Bearer` JWT + `?rk` | HIT/collapse at CDN (`public` directive) | **BYPASS** → worker runs on every request |
| SSE / HEAD / `offset=now` | `no-store` responses | never cached | never cached (unchanged) |

For auth-required streams, every read now executes the worker. Client-visible behavior is
unchanged (JWT auth passes, same responses), but the collapsing that protects the DO moves
from the CDN down into the worker's own edge-cache middleware:
`caches.default` + the isolate-local `inFlight` map (`src/http/middleware/edge-cache.ts`).

**Therefore the internal cache/coalesce layer must stay.** Before this migration it only
mattered for CDN-bypassing direct traffic (Chapter 7); after it, it is the *only* collapsing
layer for private-stream reads. Removing it as "redundant with the native cache" would
reintroduce O(readers) DO hits for every auth-required stream — a violation of the core
design constraint. (For public streams it becomes a harmless second layer behind the native
cache; on native MISS the worker still coalesces within the colo.)

Costs of accepting BYPASS on private reads: worker invocations for reads the zone CDN used to
serve for free (Chapter 2's CDN-HIT-=-$0 economics now apply only to public streams), and
per-colo rather than tiered caching for that traffic. DO load is unchanged.

### Rejected alternatives (for this pass)

- **Gateway/entrypoint split** — the pattern Cloudflare documents for caching authenticated
  traffic: an outer entrypoint authenticates, strips `Authorization`, and forwards to a cached
  named entrypoint via `ctx.exports` (per-entrypoint `cache` config in the `exports` map).
  This would restore front-of-worker caching for private streams, but it is a real
  re-architecture of auth-vs-cache ordering. Deliberately deferred; it can be layered on later
  without undoing anything in this chapter.
- **JWT in a query param** — protocol change, fragments nothing but leaks tokens into cache
  keys and logs. Rejected.

## What This Buys

- **Deletes a hop and an infra stack**: nginx, its Docker image, the EKS deployment, and the
  IPv6 resolver workaround from Chapter 7 all go away. The 4-hop path becomes 2 hops.
- **Public-stream reads**: equal or better than today — same collapsing semantics, plus tiered
  cross-colo caching, minus nginx latency/failure modes.
- **Worker-subrequest reads** (the ~80% coalescing case from Chapter 7): should improve — the
  native cache's per-key lock replaces the multi-cache-node PoP routing that caused ~9 MISSes
  per key. Needs staging confirmation.

## Staging Verification (go/no-go)

1. Public stream, 50 concurrent long-polls at the same offset+cursor from external clients →
   expect 1 worker execution, 49 collapsed (parity with Chapter 7 Test 4).
2. Auth-required stream, same test with `Bearer` + `?rk` → expect BYPASS at the native cache,
   `X-Cache: HIT`/coalesce from the internal middleware, and **1 DO hit** per poll cycle.
3. Confirm at-tail plain GETs and `offset=now` behave per Chapter 5 store rules (headers
   already encode this; native cache honors them the same way the zone CDN does).
4. Public-stream SSE (`?live=sse`): responses are `no-store`; confirm concurrent identical SSE
   GETs are not head-of-line blocked by the request-collapsing lock.
5. Deploy-time check: new Worker versions get a cold cache by default
   (`cross_version_cache`) — verify the DO absorbs the post-deploy thundering herd, or enable
   cross-version sharing.

## What Doesn't Change

- JWT auth (Chapter 3), reader keys (Chapter 12), CORS (Chapter 13), cursor rotation
  (Chapter 6), store guards and TTLs (Chapter 5), SSE/WebSocket paths, the DO read path.
- `src/http/middleware/edge-cache.ts`, `cache.ts`, `coalesce.ts` — kept, verbatim.
- The protocol's cache-control contract — Workers Cache consumes the same headers the zone
  CDN does today.
