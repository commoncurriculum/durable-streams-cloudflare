# Durable Streams on Cloudflare — Design Documentation

Internal design notes organized chronologically. The central question: how to deliver real-time stream updates to many concurrent readers at acceptable cost on Cloudflare's platform.

## Chapters

1. **[Architecture](01-architecture.md)** — Core design: DO-per-stream, SQLite hot log, R2 cold segments, internal WebSocket bridge, Hibernation API.

2. **[Cost Analysis and Design Drivers](02-cost-analysis.md)** — Cloudflare billing model, DO duration costs, transport cost comparison, CDN HIT = $0 insight, phase-by-phase cost evolution from $11,700/mo to $18/mo.

3. **[Cache Research](03-cache-research.md)** — Early findings about Workers Cache API behavior: per-datacenter scope, custom domain requirement, Worker always executes.

4. **[Cache Strategy Evolution (Phases 1–4)](04-cache-evolution.md)** — How caching strategy evolved from "cache everything" (broken) through "cache nothing" (correct but doesn't scale) to the current "cache immutable + long-poll at-tail" design.

5. **[Current Cache Architecture](05-cache-architecture.md)** — Reference for the current edge cache: store guards, what gets cached, TTLs, ETag revalidation, DO-level read coalescing.

6. **[Request Collapsing](06-request-collapsing.md)** — Making cache collapsing actually work: cursor rotation, sentinel coalescing (historical), DO stagger, WebSocket cache bridge (historical), loadtest results, key learnings.

7. **[CDN MISS Investigation](07-cdn-miss-investigation.md)** — Production CDN testing results. Two root causes: nginx IPv6 failures (fixed) and Worker subrequest coalescing limitation (platform behavior). External clients get 98–99% HIT rate.

8. **[Cache Test Coverage](08-cache-test-coverage.md)** — 29-item checklist mapping every cache behavior to a test that would break if the behavior changed.

9. **[Subscription Design](09-subscription-design.md)** — Hot push / cold catch-up subscription layer. Per-tab sessions, durable offset pointers, queue-based fan-out, client implementation sketches.

10. **[Fan-In Streams](10-fan-in-streams.md)** — Planned (not implemented). Multiplexes many source streams into one session stream for v2 scale.

11. **[Upstream Cache Proposal Comparison](11-upstream-cache-comparison.md)** — Analysis of upstream caching proposals (#58, #60, #62) vs our Cloudflare-native implementation. What's already solved, what doesn't apply, what's optional.

## Reading Order

For understanding the system end-to-end: 1 → 2 → 9 → 10.

For understanding the CDN caching story (the bulk of the investigation): 2 → 3 → 4 → 5 → 6 → 7 → 8.
