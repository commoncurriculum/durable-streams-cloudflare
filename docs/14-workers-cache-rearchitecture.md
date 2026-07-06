# Chapter 14: Workers Cache Re-Architecture

## Status: PROPOSED (adversarially reviewed; gated on Stage 0 verification + two decisions)

Cloudflare launched [Workers Cache](https://blog.cloudflare.com/workers-cache/) in
July 2026 (wrangler ≥ **4.107.0**): a tiered, request-collapsing cache that sits **in
front of a Worker entrypoint** — configurable per named `WorkerEntrypoint` via the
`exports` map, including calls made through `ctx.exports`; on a hit the callee doesn't
run. It honors `Cache-Control` (incl. `immutable`), arbitrary `Vary`, and adds
`ctx.cache.purge({tags})`.

This supersedes the hand-rolled edge cache (Chapters 5–6) and the sentinel/subrequest
collapsing limitations (Chapters 6–7) **if** we restructure rather than bolt it on. This
chapter is the design that survived three rounds of adversarial review; the two things
that did *not* survive as first written are called out as **Hard prerequisites** and a
**Non-goal**.

## The reframe: three read regimes, three primitives

A durable stream is an append-only log = **immutable content-addressed frames + one
moving tail** (see the Cursor-rotation and At-tail/Mid-stream glossary entries in
Chapter 0). That splits reads into three regimes, each matched to the right primitive
instead of forcing everything through one long-poll + `caches.default` + coalesce path:

| Regime | Condition | Primitive | DO load |
|--------|-----------|-----------|---------|
| **History** | `nextOffset < tail` | Edge cache, `Cache-Control: immutable`, keyed on `(doKey, epoch, offset)` | ~1 fill / colo / frame |
| **Live tip — massive fan-out** | at tail, ~poll-interval latency OK | **Frame-polling**: GET the next frame's URL; the not-yet-existing frame is negatively cached ~1s | **O(colos / pollInterval)** — independent of watcher count |
| **Live tip — low latency** | at tail, bounded fan-out | Held long-poll / SSE / hibernating WS direct to DO | bounded by caps (long-poll 10K waiters, WS ~32K sockets/DO) |

Frame-polling is the key addition: it converts live fan-out into cache fan-out using the
same immutable-frame machinery, so DO load stops scaling with watcher count. That is what
actually lifts the 1M ceiling (at the cost of ~poll-interval latency).

## Architecture: Gateway + cached Reader entrypoint

```
Client ──(JWT, Origin)──▶ Gateway entrypoint  [default export · cache DISABLED · ALWAYS runs]
   • auth (JWT) + authorization + CORS + path parse → project-qualified doKey
   • build a props-free, header-CLEAN inner Request (no Authorization/Cookie —
     else the platform returns cf-cache-status: BYPASS and caching silently dies)
   • route:
        plain GET (history OR frame-poll)   → ctx.exports.Reader   (CACHED)
        held long-poll / sse / Upgrade:ws   → StreamDO direct      (bypass cache)
   • on return: apply per-origin CORS + set X-Cache from cf-cache-status  (hit AND miss)
        │                                                     │
        ▼ ctx.exports (cache keyed on inner URL only)         ▼ RPC (no cache)
   Reader entrypoint  [named WorkerEntrypoint · cache ENABLED]   StreamDO [1 per stream]
   /read/<doKey>/<epoch>@<absOffset>?cap=<readerKey|∅>            • held long-poll (≤10K)
   sets Cache-Control by the DO's real answer:                    • hibernating WS (≤32K)
     • R2-backed frame, nextOffset<tail → immutable, max-age=<≤TTL>, Content-Length set
     • upToDate                          → no-store  (never freeze liveness)
     • frame not yet (poll gap)          → public, max-age=1  (negative cache → collapse)
```

This structure fixes, structurally, the problems that killed a naïve "cache in front of
the whole worker" (Chapter 5's model taken to the new feature):

| Naïve-adoption hazard | Dissolved because… |
|---|---|
| Native cache serves a hit before auth → JWT bypass | Gateway runs auth on **every** request; cache is *behind* it. |
| Private streams need reader-key-as-bearer to cache | Key = resolved `cap` (stable per-stream reader key, **not** the JWT); no JWT → never reaches cache. JWT stays enforced/expiring. |
| CORS baked into cache → `Vary: Origin` fragments collapsing | Gateway applies CORS *after* the cache, per-request. Cached bytes are CORS-free. |
| `X-Cache` unsettable on a hit | Gateway runs on hits; maps `cf-cache-status` → `X-Cache`. |
| At-tail read-after-write | Only R2-backed non-tail frames are `immutable`; the tip is `no-store`/negative-cached. No mutable resource is ever cached. |
| Whole-worker cache → `no-store` every route | Cache is scoped to the Reader entrypoint only; mutations/subscriptions/estuary/tip never touch it. |

## Hard prerequisites (reads are NOT immutable at a fixed offset today)

Adversarial review proved these false in the current storage layer; caching `immutable`
without fixing them serves permanently divergent bytes across colos.

1. **Frame = pure function of `(doKey, epoch, offset)`.** Today a binary append > 256 KB
   (`MAX_CHUNK_BYTES`) returns the whole row from hot storage (`storage/stream-do/read.ts`)
   but a truncated 256 KB chunk from R2 (`storage/stream-do/read-messages.ts`) — different
   body, `nextOffset`, and ETag. `Stream-Write-Timestamp` (R2 defaults 0) and the ETag's
   `closed` bit also diverge by tier. **Simplest safe rule:** only mark a frame `immutable`
   once it is R2-backed and read with the canonical chunking the cache will serve; hot /
   at-tail stays `no-store` or short-TTL. JSON framing is already tier-stable (per-message
   ops) — the normalization work is the binary path.
2. **Predicate is `!upToDate` (`nextOffset < tail`), never start-offset `< tail`.** The
   offset path (`http/v1/streams/read/index.ts`) must emit `no-store` when `upToDate` — it
   does not today. Caching an `upToDate` body immutable tells a client "caught up" forever.
3. **Monotonic `epoch` persisted in the DO, bumped on delete.** Not KV `created_at`
   (eventually-consistent; `putStreamMetadata` read-modify-write reuses the old value on a
   fast recreate → stale frames served for a new stream at reused offsets).
4. **Cache key uses project-qualified `doKey` (`projectId/streamId`)**, never bare
   `streamId` (cross-tenant collision → data leak).
5. **`cap` hygiene + non-public Reader.** `cap` is a cache partition, not an authorizer
   (authorization gates on JWT, never checks `rk`). Keep it out of logged/analyzed URLs
   (Hono `logger()` is mounted on `*`) and prove in Stage 0 the Reader entrypoint is not
   externally routable.

## Silent-failure keying hazards (fail as MISS/BYPASS, invisible locally)

- **`ctx.props` participate in the cache key.** Any per-request prop on the Reader call
  shards 1M followers into 1M entries. The Gateway must pass **zero** props; tenancy lives
  only in the `?cap=` URL segment.
- **`Authorization`/`Cookie` headers force `BYPASS`.** The inner Request must be fully
  stripped of auth headers, not merely "not the JWT."
- **Per-subscriber reader keys** would fragment the history cache per user → zero
  collapsing for private streams. `cap` must be **one stable key per stream**.
- **Cross-colo collapsing is unverified.** Cloudflare cache is per-colo; "one origin fill"
  needs tiered caching to apply to the cached entrypoint. Worst case ≈ one fill per colo
  (≈ today). Provable only on staging (miniflare cannot emulate it — see Chapter 7).

## Stages

- **Stage 0 — Prove the platform facts (blocking).** `pnpm install`; bump wrangler ≥ 4.107.0
  and `compatibility_date` (repo `2026-02-02` → CF example `2026-05-01`, pin empirically).
  Go/no-go, each of which fails silently as MISS/BYPASS: per-entrypoint `cache`/`ctx.exports`
  caching; **two distinct JWTs on the same `cap` → shared HIT** (staging + DO-fill counter);
  cross-colo/tiered collapsing; non-public Reader; `immutable` + `Content-Length` long hits.
  If any fail, fall back to the incremental additive plan (public-only native cache in front,
  hand-rolled layer kept).
- **Stage 1 — Immutable-frame correctness (ships without the split).** Implement the 5
  prerequisites; drive `Cache-Control` off the DO's real answer. Makes today's `caches.default`
  path correct with no feature dependency. Guardrails: hot/R2 byte-identical frame; `no-store`
  on `upToDate`; epoch bumps on recreate.
- **Stage 2 — Gateway/Reader split + frame-polling.** Add the `Reader` `WorkerEntrypoint`
  (reuses `readStream`); reduce default export to Gateway (reuses auth/CORS middleware).
  Clean inner Request; frame-polling negative-cache; enable `cache` scoped to Reader in
  `wrangler.toml` + 4 test configs. **Route the cache decision on the DO's offset-vs-tail
  answer, not request shape** (catch-up long-poll at a behind offset must still hit the
  cache). Keep a slim `live=long-poll` edge coalescer (isolate-local — the reason held
  long-poll stays a *bounded* low-latency option). Delete redundant cache machinery
  (`caches.default` match/put, 200ms linger, `buildPreCacheResponse` warm-up, `LONGPOLL_STAGGER`).
- **Stage 3 — Invalidation + polish (optional).** `Cache-Tag: stream:<doKey>` + `ctx.cache.purge`
  on delete (behind the epoch). WS/SSE for low-latency bounded fan-out.

## Non-goal (stated, not hand-waved)

**Low-latency push beyond ~32K watchers per stream** is not solved here. WS hibernation
caps at ~32K sockets/DO and broadcast is O(N) synchronous CPU per append on the single DO
thread; long-poll caps at 10K. Serving that regime requires a **relay-DO fan-out tree**
(the origin DO broadcasts each append to K relay DOs, each holding a bounded socket shard)
— a separate, larger project. Frame-polling covers the massive-fan-out case at
poll-interval latency without it.

## Verification

CI-parity from repo root (`typecheck | format:check | lint`, server `test:unit`,
`conformance`, implementation `test`).
- **Stage 1 (local, gating):** hot/R2 frame byte-identical; `no-store` on `upToDate`;
  epoch bumps on recreate; conformance unchanged.
- **Stage 2 (local):** private read with no/expired JWT → 401 even with a warm entry;
  cross-origin CORS correct; catch-up long-poll still cache-served.
- **Stage 2 (staging — miniflare can't emulate tiering):** two JWTs / same `cap` → shared
  HIT + one DO fill; N concurrent history reads → HITs + one fill; frame-poll gap → one DO
  request per colo per second regardless of poller count.

## Two decisions for sign-off

1. **Security boundary** — recommended: private streams cache behind the Gateway keyed on
   a stable per-stream `cap` (not the JWT, not per-subscriber). The alternative (drop JWT,
   `rk`-as-bearer) is a downgrade and not recommended.
2. **How far in one pass** — recommended: land Stage 1 (frame correctness, independent
   value) first, then the Stage 2 split after Stage 0 staging proof; the relay-DO tree is
   explicitly deferred.

## Related chapters

Supersedes/evolves: [4](04-cache-evolution.md), [5](05-cache-architecture.md),
[6](06-request-collapsing.md), [7](07-cdn-miss-investigation.md). Auth model:
[3](03-authentication.md). Reader key: [12](12-cdn-reader-key.md). CORS: [13](13-cors-configuration.md).
Test-coverage discipline to extend: [8](08-cache-test-coverage.md).
