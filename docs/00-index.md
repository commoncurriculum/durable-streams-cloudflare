# Durable Streams on Cloudflare -- Design Documentation

Internal design notes organized chronologically. The central question: how to deliver real-time stream updates to many concurrent readers at acceptable cost on Cloudflare's platform.

## Glossary

| Term | Definition |
|------|-----------|
| **`read_seq`** | Segment generation counter. Increments each time the hot log is rotated to an R2 segment. Forms the first half of the offset encoding (`readSeq_byteOffset`). |
| **Cursor rotation** | The mechanism by which the DO returns a new `Stream-Cursor` value with every long-poll response. The cursor is a query parameter in the URL, so each response naturally produces a different cache key for the next request, preventing stale cache loops. |
| **Sentinel coalescing** | (Historical, removed.) A cross-isolate coordination mechanism where the first cache-miss isolate stores a short-lived marker in `caches.default` so later arrivals poll for the cached result instead of hitting the DO. Superseded by CDN request collapsing. |
| **Colo / PoP** | Cloudflare datacenter (Point of Presence). Used interchangeably. Each colo has its own independent cache. |
| **Isolate** | A V8 isolate -- the lightweight execution context in which a Cloudflare Worker runs. Each concurrent request typically gets its own isolate. In-memory state (Maps, variables) is NOT shared across isolates. |
| **Store guard** | A conditional check in the edge worker that decides whether to call `cache.put()` for a given response. The current guard is: `status === 200 && !cc.includes("no-store") && (!atTail \|\| isLongPoll)`. |
| **At-tail** | A read response where the client has reached the latest data in the stream. Indicated by the `Stream-Up-To-Date: true` header. |
| **Mid-stream** | A read response where there is more data after the returned range. The client is catching up, not at the live edge. |

## Chapters

1. **[Architecture](01-architecture.md)** -- Core design: DO-per-stream, SQLite hot log, R2 cold segments, internal WebSocket bridge, Hibernation API.

2. **[Cost Analysis and Design Drivers](02-cost-analysis.md)** -- Cloudflare billing model, DO duration costs, transport cost comparison, CDN HIT = $0 insight, phase-by-phase cost evolution from $11,700/mo to $18/mo.

3. **[Authentication](03-authentication.md)** -- Per-project JWT auth (HS256), KV registry for signing secrets, scope enforcement, stream-scoped tokens, public stream bypass, custom auth callbacks.

4. **[Cache Research and Strategy Evolution (Phases 1-4)](04-cache-evolution.md)** -- Initial cache research findings (Workers always execute, cache is per-colo, custom domain required), then how caching evolved from "cache everything" (broken) through "cache nothing" (correct but doesn't scale) to the current "cache immutable + long-poll at-tail" design.

5. **[Current Cache Architecture](05-cache-architecture.md)** -- Authoritative reference for the current edge cache: store guards, what gets cached, TTLs, ETag revalidation, DO-level read coalescing. This is the single source of truth for cache policy.

6. **[Request Collapsing](06-request-collapsing.md)** -- Making cache collapsing actually work: cursor rotation, sentinel coalescing (historical), DO stagger, WebSocket cache bridge (historical), loadtest results, key learnings.

7. **[CDN MISS Investigation](07-cdn-miss-investigation.md)** -- Production CDN testing results. Two root causes: nginx IPv6 failures (fixed) and Worker subrequest coalescing limitation (platform behavior). External clients get 98-99% HIT rate.

8. **[Cache Test Coverage](08-cache-test-coverage.md)** -- 29-item checklist mapping every cache behavior to a test that would break if the behavior changed.

9. **[Subscription Architecture](09-subscription-design.md)** -- The implemented subscription layer: SubscriptionDO + SessionDO dual-DO model, publish and fan-out flow, circuit breaker, producer deduplication, queue consumer, Analytics Engine metrics, cron-based session cleanup.

10. **[Fan-In Streams](10-fan-in-streams.md)** -- Planned (not implemented). Multiplexes many source streams into one session stream for v2 scale. See Chapter 9 for the currently implemented subscription system.

11. **[Upstream Cache Proposal Comparison](11-upstream-cache-comparison.md)** -- Analysis of upstream caching proposals (#58, #60, #62) vs our Cloudflare-native implementation. What's already solved, what doesn't apply, what's optional.

12. **[CDN Reader Key](12-cdn-reader-key.md)** -- Per-stream shared reader key design for CDN-cached read authorization. Prevents unauthorized reads of cached responses without fragmenting the cache.

13. **[CORS Configuration](13-cors-configuration.md)** -- Per-project CORS origins stored in REGISTRY KV. Migration guide from the removed `CORS_ORIGINS` env var.

14. **[S2 Integration Options](14-s2-integration-options.md)** -- In-depth analysis of three approaches to integrating S2.dev: as a backing store replacement, via protocol adapter, or with a native S2 client library. Includes implementation details, cost comparisons, feature matrices, and migration roadmaps.

15. **[S2 Native Client Deep Dive](15-s2-native-client-deep-dive.md)** -- Detailed analysis of S2's authentication model and building an auth proxy to preserve JWT-based UX. Includes S2 access token scoping, JWT-to-S2-token exchange implementation, complete code examples, and migration path. Compares S2's granular permission system with Durable Streams' JWT auth.

16. **[Client API & CDN Comparison](16-client-api-cdn-comparison.md)** -- Side-by-side comparison of Durable Streams HTTP-first API vs S2 SDK-first API. Analyzes developer experience, type safety, and feature parity. Examines S2's CDN compatibility and explains Durable Streams' offset/cursor-based caching design that enables 99% HIT rate and 162x cost reduction. Includes recommendations by workload type.

17. **[S2 HTTP API & CDN Strategies](17-s2-http-api-cdn-strategies.md)** -- Confirms S2 has full REST API (SDK optional). Explores three strategies for enabling CDN caching with S2: protocol adapter with transformation, caching proxy with headers, and hybrid approach. Includes complete implementation examples for Durable Streams → S2 protocol adapter with cursor rotation and at-tail detection. Cost analysis: $68-218/month (S2+CDN) vs $18/month (current DO+CDN).

## Reading Order

**End-to-end system understanding**: 1 -> 2 -> 3 -> 9

**CDN caching deep-dive** (the bulk of the investigation): 2 -> 4 -> 5 -> 6 -> 7 -> 8

**Debugging a cache miss in production**: 5 -> 7 -> 8

**Understanding cost implications**: 2

**Adding a new cache behavior**: 5 -> 8 (coverage checklist)

Most developers working on this codebase will need Chapters 1, 2, 5, and 9 at minimum. The cache chapters (4-8) are essential context since caching is in the main request path (`create_worker.ts`).

## Other Packages

These packages have their own READMEs and are not covered in the design chapters above:

| Package | Purpose |
|---------|---------|
| `packages/loadtest/` | Distributed loadtest tooling — local and edge Worker modes, CDN diagnostic tool, Analytics Engine metrics. Referenced from Chapter 7. |
| `packages/cli/` | Setup wizard for new projects — scaffolds Cloudflare resources (R2 buckets, KV namespaces) and deploys workers. |
| `packages/admin-core/` | Admin dashboard for the core worker (TanStack Start app). Uses core's RPC interface via service bindings. |
| `packages/admin-subscription/` | Admin dashboard for the subscription worker (TanStack Start app). Uses subscription's RPC interface via service bindings. |
| `packages/proxy/` | Nginx reverse proxy configuration for CDN routing. See Chapter 2 (why the proxy exists) and Chapter 7 (IPv6 fix, elimination options). |
