# Cache-Control: public vs private — Research Needed

## Context

The Durable Streams protocol spec says:

- Shared/public streams SHOULD use `Cache-Control: public`
- User-specific/confidential streams SHOULD use `Cache-Control: private`

Currently, `packages/core/src/protocol/expiry.ts` always returns `Cache-Control: public, max-age=60, stale-while-revalidate=300` (or variants) for all streams regardless of whether they are public or authenticated.

## Architecture

- Edge Worker (`packages/core/src/http/create_worker.ts`) enforces auth on every request before forwarding to the DO
- Streams can be marked public via `?public=true` on PUT — stored in KV
- Public/private adn skipping auth is ireelvant -- auth is just a function inside the worker. The important questio: do all request hit the worker or does the cache control cause requests to skip it if it's alreayd cached?
- The DO generates the response including Cache-Control headers
- There is no `caches.default` usage in the edge worker (confirmed in `docs/cdn-cache-flow.md`)

## Questions

1. In Cloudflare's architecture, is the Worker invoked on every request to its route, or can Cloudflare's CDN cache layer serve responses without invoking the Worker? Does this change depending on whether you use a custom domain vs workers.dev?

2. If the Worker always runs, does `Cache-Control: public` only affect downstream caches (browser, proxies between client and Cloudflare)? Is there any scenario where `public` causes cross-user cache leakage?

3. Do we need to add a stream specific auth key that we give to all the clients after they first join? E.g. they join and we redirect them with an autehtnicated key that's shared across sessions and that's the thing that's cached?

4. What is the practical difference between `Cache-Control: public` and `Cache-Control: private` when the response originates from a Cloudflare Worker (not a traditional origin server)?

## Relevant Files

- `packages/core/src/protocol/expiry.ts` — `cacheControlFor()` function
- `packages/core/src/http/create_worker.ts` — edge worker auth + caching flow
- `packages/core/src/http/worker.ts` — internal worker between edge and DO
- `docs/cdn-cache-flow.md` — documented CDN caching model
