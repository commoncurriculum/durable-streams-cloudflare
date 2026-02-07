# Cache-Control: Research Resolved

## Findings

### 1. Workers ALWAYS execute on every request

Cloudflare Workers run before the cache. `Cache-Control` headers do NOT cause Cloudflare to skip the Worker. To cache at the edge, the Worker must explicitly use `cache.put()` / `cache.match()`.

### 2. Cache-Control: public vs private

Since Workers always execute, `public` vs `private` only matters for downstream caches (browser, proxies). There is no risk of cross-user cache leakage at the Cloudflare edge because auth runs in the Worker before cache lookup. We use `public` for all cacheable responses per the protocol spec.

### 3. Cache API requires a custom domain

`caches.default` silently no-ops on `workers.dev` subdomains. Only workers deployed to custom domains have functional cache operations.

### 4. Cache is per-datacenter

Each PoP builds its own cache organically. A cached response in one datacenter won't serve requests routed to another.

## Implementation

Edge caching was implemented in `create_worker.ts` using `caches.default`. See `docs/cdn-cache-flow.md` for the full architecture.
