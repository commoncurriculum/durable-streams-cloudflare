# CDN Cache Architecture

## Edge Worker: Stateless Forwarder

The edge worker (`create_worker.ts`) is a stateless forwarder. It handles:

- **CORS** and **OPTIONS** preflight
- **Auth** (JWT verification, public stream bypass via KV)
- **Routing** to the correct Durable Object
- **KV metadata** on stream creation
- **Server-Timing** headers (when debug is enabled)

It does **not** cache responses. There is no `caches.default` usage.

## Cache-Control Headers (set by the DO)

The Durable Object sets protocol-correct `Cache-Control` headers on all read responses via `cacheControlFor()`:

| Scenario | Cache-Control | Why |
|----------|--------------|-----|
| Non-TTL stream (open or closed) | `public, max-age=60, stale-while-revalidate=300` | Protocol section 8: all catch-up reads are cacheable |
| TTL stream with time remaining | `public, max-age=min(60, remaining)` | Cache respects TTL expiry |
| Expired TTL stream | `no-store` | Content is gone |
| HEAD responses | `no-store` | Metadata-only, always fresh |
| `?offset=now` | `no-store` | Cursor bootstrap, must be fresh |
| SSE / long-poll | Not cached (streaming) | Real-time delivery |

The protocol accepts up to 60 seconds of staleness by design. Clients that need fresher data use `If-None-Match` (ETag) or real-time modes (SSE, long-poll).

## External CDN Caching

If you deploy behind a custom domain with Cloudflare Cache Rules, the `Cache-Control` headers above drive CDN behavior automatically. No special configuration is needed beyond standard HTTP caching semantics.

## DO-Level Deduplication

The `ReadPath` class inside the DO coalesces concurrent reads:

- **In-flight dedup**: identical reads share a single storage call
- **Recent-read cache**: 100ms TTL, auto-invalidated by `meta.tail_offset` in the cache key (changes on every write)

This collapses bursts of identical requests at the DO level without risking stale reads.

## Summary

| Layer | Role |
|-------|------|
| Edge worker | Auth + CORS + routing (no cache) |
| Durable Object | Sets `Cache-Control` headers per protocol |
| ReadPath coalescing | DO-level request dedup (100ms, auto-invalidating) |
| External CDN (optional) | Honors `Cache-Control` headers on custom domains |
