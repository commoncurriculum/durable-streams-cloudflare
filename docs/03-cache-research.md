# Chapter 3: Cache Research

Before implementing edge caching, we investigated how Cloudflare's cache layer interacts with Workers. These findings shaped every decision that followed.

## 1. Workers ALWAYS execute on every request

Cloudflare Workers run before the cache. `Cache-Control` headers do NOT cause Cloudflare to skip the Worker. To cache at the edge, the Worker must explicitly use `cache.put()` / `cache.match()`.

This means the Worker is always in control — it decides what to cache, when to serve from cache, and when to bypass. There is no implicit caching behavior to worry about.

## 2. Cache-Control: public vs private

Since Workers always execute, `public` vs `private` only matters for downstream caches (browser, proxies). There is no risk of cross-user cache leakage at the Cloudflare edge because auth runs in the Worker before cache lookup. We use `public` for all cacheable responses per the protocol spec.

## 3. Cache API requires a custom domain

`caches.default` silently no-ops on `workers.dev` subdomains. Only workers deployed to custom domains have functional cache operations. This is a deployment requirement, not a code issue — everything works in tests (miniflare implements `caches.default` locally) but produces 0% HIT in production if you forget the custom domain.

## 4. Cache is per-datacenter

Each Cloudflare PoP builds its own cache organically. A cached response in Dallas won't serve requests routed to London. Cache warming happens naturally from client traffic — there is no global cache propagation.

This has implications for request collapsing: the cache only collapses requests within a single colo. Clients routed to different PoPs build independent caches.
