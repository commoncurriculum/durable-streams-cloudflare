# Unified Fix Plan — Durable Streams

Merged from Code Reviews #1, #2, and #3. Duplicates consolidated, conflicts resolved, dependencies noted.

---

## Summary Table

| ID | Title | Package | Priority | Effort | Dependencies | Status |
|----|-------|---------|----------|--------|--------------|--------|
| FIX-001 | Remove wildcard CORS default | core, subscription | P0 | S-M | -- | **DEFERRED** (user wants per-project KV CORS) |
| FIX-002 | Segment rotation non-atomic | core | P0 | S | -- | **DONE** (8fbddb5) |
| FIX-003 | SSE broadcast is sequential | core | P1 | M | -- | **DONE** (8fbddb5) |
| FIX-004 | DO storage quota enforcement | core | P1 | M | -- | **DONE** (8fbddb5) |
| FIX-005 | Fanout without backpressure / circuit breaker | subscription | P0 | M-L | -- | **DONE** (8fbddb5) |
| FIX-006 | Add NaN guards after parseInt on env vars | subscription | P1 | S | -- | **DONE** (8fbddb5) |
| FIX-007 | Producer ID pattern validation | core | P0 | S | -- | **DONE** (8fbddb5) |
| FIX-008 | Replace GitHub PR preview dependency | subscription | P0 | S | -- | **SKIPPED** (no stable vitest 4 support) |
| FIX-009 | Extract shared JWT and auth logic | core, subscription | P1 | M | -- | **SKIPPED** (user: too much work for little gain) |
| FIX-010 | Add stream_id claim to subscription JWT | subscription | P1 | S | FIX-009 | **DONE** (8fbddb5) |
| FIX-011 | Structured logging with context | core, subscription | P1 | L | -- | **DONE** (8fbddb5) |
| FIX-012 | Standardize error response format to JSON | core | P1 | M | -- | **DONE** (8fbddb5) |
| FIX-013 | Fix wrangler test config compatibility_date | subscription | P1 | S | -- | **DONE** (8fbddb5) |
| FIX-014 | KV cleanup retry on stream deletion | core | P1 | S-M | -- | **DONE** (8fbddb5) |
| FIX-015 | R2 segment deletion error handling | core | P1 | M | -- | **DONE** (8fbddb5) |
| FIX-016 | SSE clients Map bounded | core | P1 | M | -- | **DONE** (8fbddb5) |
| FIX-017 | LongPollQueue waiters bounded | core | P1 | S | -- | **DONE** (8fbddb5) |
| FIX-018 | WebSocket broadcast error logging | core | P1 | S | FIX-011 | **DONE** (8fbddb5) |
| FIX-019 | Auth route parsing — exact match | subscription | P0 | S | -- | **DONE** (8fbddb5) |
| FIX-020 | Cleanup batch concurrency limit | subscription | P1 | M | -- | **DONE** (8fbddb5) |
| FIX-021 | URL parameter validation on DELETE routes | subscription | P1 | S | -- | **DONE** (8fbddb5) |
| FIX-022 | Metrics/logging for subscribe rollback failures | subscription | P1 | M | FIX-011 | **DONE** (8fbddb5) |
| FIX-023 | Document KV ACL requirement for REGISTRY | core, subscription | P1 | S | -- | **DONE** (8fbddb5) |
| FIX-024 | Document CORS fallback behavior differences | core, subscription | P1 | S | FIX-001 | **DEFERRED** (blocked by FIX-001) |
| FIX-025 | Add comments to fire-and-forget .catch patterns | core | P1 | S | -- | **DONE** (8fbddb5) |
| FIX-026 | Pin devDependency versions | all | P2 | S | -- | **DONE** |
| FIX-027 | Standardize tsconfig across packages | all | P2 | M | -- | TODO |
| FIX-028 | Analytics SQL query builder helper | subscription, admin-* | P2 | M | -- | TODO |
| FIX-029 | ReadPath in-flight caches bounded | core | P2 | M | -- | **DONE** |
| FIX-030 | inFlight Map bounded | core | P2 | M | -- | **DONE** |
| FIX-031 | Content-type parameter handling test | core | P2 | S | -- | **DONE** |
| FIX-032 | Stream-Seq semantics documented | core | P2 | S | -- | **DONE** |
| FIX-033 | Producer TTL documented | core | P2 | S | -- | **DONE** |
| FIX-034 | Conformance test timeout | core | P2 | S | -- | **DONE** |
| FIX-035 | Replace hardcoded CACHE_SETTLE_MS with poll | core | P2 | M | -- | **DONE** |
| FIX-036 | Per-test stream cleanup in subscription tests | subscription | P2 | M | -- | **SKIPPED** (tests use unique UUIDs; workers are ephemeral) |
| FIX-037 | Replace `any` casts with TS interfaces (admin-core) | admin-core | P2 | M | -- | **DONE** |
| FIX-038 | Replace `Record<string, unknown>` cast with TS interface (admin-sub) | admin-subscription | P2 | S | -- | **DONE** |
| FIX-039 | Review React hook dependency / tokenRef pattern | admin-subscription | P2 | M | -- | **DONE** (pattern is sound, already documented) |
| FIX-040 | Subscription response headers non-standard | subscription | P2 | S | -- | **DONE** |
| FIX-041 | Session route error inconsistency | subscription | P2 | S | -- | **DONE** |
| FIX-042 | Fanout failure logging | subscription | P2 | M | FIX-011 | **DONE** |
| FIX-043 | DO operation timing instrumentation | core | P2 | M | -- | **DONE** |
| FIX-044 | Use SessionDO RPC for cleanup subscriptions | subscription | P2 | M | -- | **DONE** |
| FIX-045 | Document vitest beta version rationale | subscription | P2 | S | -- | **DONE** (FIX-008 skip in CLAUDE.md already documents this) |
| FIX-046 | Extract shared test helpers | core, subscription | P2 | M | -- | TODO |
| FIX-047 | Add test for queue fallback path | subscription | P2 | M | -- | **DONE** |
| FIX-048 | Document or remove extractBearerToken export | core | P2 | S | -- | **DONE** |
| FIX-049 | Surface actual error messages in all error responses | core, subscription | P2 | S-M | FIX-012 | **DONE** (a4c5e9d, d33904f) |

---

## P0 — Fix Now

### `packages/core`

#### FIX-001: Remove wildcard CORS default, require explicit configuration
- **Sources:** Review 3 (SEC-1)
- **What:** Unconfigured deployments silently default to `*` (all origins), which means any site can make credentialed cross-origin requests to the API.
- **Where:**
  - `packages/core/src/http/create_worker.ts:47-53`
  - `packages/subscription/src/http/create_worker.ts:26-49`
- **How:** Use lazy per-request validation: on the first request, check for `CORS_ORIGINS` and log a loud deprecation warning if missing while defaulting to `*`. Schedule breaking change (error on missing `CORS_ORIGINS`) for next major version. Note: "throw at startup" is infeasible on Cloudflare Workers since `env` is only available inside request handlers. Must also update both `wrangler.test.toml` files to set `CORS_ORIGINS` for tests.
- **Effort:** S-M

#### FIX-002: Segment rotation non-atomic — orphaned ops on crash
- **Sources:** Review 2 (CORE-5)
- **What:** The rotation sequence R2.put → insertSegment → updateStream → deleteOpsThrough is non-atomic. A crash between updateStream and deleteOpsThrough leaves orphaned ops in hot storage (wasted DO storage, not a data duplication issue on read — the read path already routes via `segment_start` boundary).
- **Where:** `packages/core/src/stream/rotate.ts:79-124`
- **How:** Batch `deleteOpsThrough` into the same `storage.batch()` call as the stream metadata update (step 3). Both are SQLite operations and can be made atomic within a single batch. This eliminates the crash window between steps 3 and 4. The crash window between R2.put and insertSegment leaves orphaned R2 objects — address with periodic R2 garbage collection at P2 priority.
- **Effort:** S

#### FIX-007: Producer ID pattern validation
- **Sources:** Review 3 (SEC-2)
- **What:** Producer ID only checked for empty string, accepts any arbitrary string including control characters or multi-megabyte strings.
- **Where:** `packages/core/src/stream/producer.ts:45-47`
- **How:** Add `PRODUCER_ID_PATTERN` regex (e.g., `/^[a-zA-Z0-9_\-:.]{1,256}$/`). Validate before storage. Return 400 on mismatch. Max length 256 to accommodate `fanout:` prefix + long stream IDs. Check conformance test suite for producer ID edge cases before restricting.
- **Effort:** S

### `packages/subscription`

#### FIX-019: Auth route parsing — exact match (ELEVATED to P0)
- **Sources:** Review 2 (SUB-6)
- **What:** Auth uses substring checks (`pathname.includes("/subscribe")`) which is an actual auth bypass — a session with an ID containing "subscribe" skips auth on DELETE. The anchored regexes (`SESSION_DELETE_RE`, `SUBSCRIBE_RE`, `UNSUBSCRIBE_RE`) already prevent route overlap, making the `includes()` guards redundant and harmful.
- **Where:** `packages/subscription/src/http/auth.ts:65`
- **How:** Remove the `includes()` checks entirely — the anchored regexes are tested in method-gated blocks and already prevent overlap. No replacement regex needed.
- **Effort:** S

#### FIX-005: Fanout without backpressure / circuit breaker
- **Sources:** Review 2 (SUB-5)
- **What:** When the queue is unavailable, inline fanout serializes all RPCs. No circuit breaker exists. A single slow session blocks the entire publish path.
- **Where:**
  - `packages/subscription/src/subscriptions/fanout.ts:25-36`
  - `packages/subscription/src/subscriptions/do.ts:171-207`
- **How:** Add a circuit breaker as a DO instance variable with a counter and half-open retry window (e.g., retry every 60s). When circuit is open, skip inline fanout and return success with metadata indicating fanout was deferred (never return 503 — the source write at line 126-131 has already committed). Limit inline fanout to max 1K subscribers (configurable via env var). Use `Promise.race` with `setTimeout` for per-RPC timeouts since Workers RPC has no native timeout config.
- **Effort:** M-L

#### FIX-008: Replace GitHub PR preview dependency
- **Sources:** Review 3 (SEC-3)
- **What:** `@cloudflare/vitest-pool-workers` is pinned to a GitHub PR build URL. Supply-chain risk.
- **Where:** `packages/subscription/package.json:41`
- **How:** Replace with official npm release. If no stable release exists, vendor the tarball or pin to a specific commit hash.
- **Effort:** S

---

## P1 — This Sprint

### `packages/core`

#### FIX-003: SSE broadcast is sequential (moved from P0)
- **Sources:** Review 2 (CORE-6)
- **What:** Broadcasting to SSE clients uses sequential `for...await`. SSE clients are internal WebSocket bridge connections (not end-user connections), so the "100K clients" scenario is implausible at DO scale, but batching is still a defensive improvement.
- **Where:** `packages/core/src/http/handlers/realtime.ts:470-493`
- **How:** Replace sequential loop with batched `Promise.allSettled()` in groups of 100-500 clients. Failed writes should close those clients and remove them from the Map. Note: concurrent `closeSseClient` calls modify the shared clients Map — implementation must handle Map mutation during iteration carefully. Also apply same treatment to `broadcastSseControl` (lines 495-513).
- **Effort:** M

#### FIX-004: DO storage quota enforcement (moved from P0)
- **Sources:** Review 2 (CORE-16)
- **What:** No warnings or limits when approaching the Durable Object storage limit. Exceeding it causes unrecoverable errors. Defense-in-depth — segment rotation already moves data to R2.
- **Where:** `packages/core/src/stream/rotate.ts`
- **How:** Simpler approach: check existing `meta.segment_bytes` against a configurable threshold (no new API needed). Also consider `ctx.storage.sql.databaseSize` as a secondary check. Return HTTP 507 at 90% capacity. Must document that without R2 configured, there is no cold-storage offload.
- **Effort:** M

#### FIX-012: Standardize error response format to JSON
- **Sources:** Review 3 (CQ-1)
- **What:** Core returns `text/plain` error bodies while subscription returns JSON. Clients must handle two formats.
- **Where:** `packages/core/src/protocol/errors.ts:4-6`
- **How:** Update `errorResponse()` to return `Response.json({ error: message }, { status })`. Update tests.
- **Effort:** M

#### FIX-014: KV cleanup retry on stream deletion
- **Sources:** Review 2 (CORE-7)
- **What:** KV metadata cleanup on stream deletion is fire-and-forget with no retry. Transient failure leaves orphaned metadata.
- **Where:** `packages/core/src/http/durable_object.ts:152-162`, also `packages/core/src/http/handlers/write.ts:289-291`
- **How:** Wrap `KV.delete()` in retry loop (max 3 attempts with backoff). Log on final failure.
- **Effort:** M

#### FIX-015: R2 segment deletion error handling
- **Sources:** Review 2 (CORE-8)
- **What:** R2 segment deletion runs in `waitUntil()` without error handling. Failures leave orphaned R2 objects.
- **Where:** `packages/core/src/http/handlers/write.ts:280-287`
- **How:** Add try/catch. Log failures with segment key context.
- **Effort:** M

#### FIX-016: SSE clients Map bounded
- **Sources:** Review 2 (CORE-9)
- **What:** No per-stream limit on SSE connections.
- **Where:** `packages/core/src/http/handlers/realtime.ts:68-71` (SseState type), line 426 (clients.set call)
- **How:** Add configurable max SSE client count (default 10K). Return 503 if exceeded.
- **Effort:** M

#### FIX-017: LongPollQueue waiters bounded
- **Sources:** Review 2 (CORE-10)
- **What:** Waiters array grows without limit; two O(n) filters per notify.
- **Where:** `packages/core/src/http/handlers/realtime.ts:85-157`
- **How:** Add max waiter count. Replace two filters with single loop.
- **Effort:** S

#### FIX-018: WebSocket broadcast error logging
- **Sources:** Review 1 (CORE-1)
- **What:** Deserialization errors during WS broadcast are silently discarded.
- **Where:** `packages/core/src/http/handlers/realtime.ts:845-847` (broadcastWebSocket catch), `:882-884` (broadcastWebSocketControl catch), `:776-777` (sendWsCatchUp catch)
- **How:** Add `console.error` with context. Upgrade to structured logging when FIX-011 lands.
- **Dependencies:** FIX-011 (nice-to-have)
- **Effort:** S

#### FIX-025: Add comments to fire-and-forget .catch patterns
- **Sources:** Review 3 (CQ-2)
- **What:** Silent `.catch(() => {})` patterns are indistinguishable from bugs.
- **Where:** `packages/core/src/http/create_worker.ts:147,152,175,183,187`, `packages/core/src/http/handlers/write.ts:291`
- **How:** Add `// Fire-and-forget: [reason]` comment above each.
- **Effort:** S

### `packages/subscription`

#### FIX-006: Add NaN guards after parseInt on env vars (moved from P0)
- **Sources:** Review 1 (SUB-1)
- **What:** If numeric environment variables are misconfigured, `Number.parseInt()` returns `NaN` which silently propagates into TTL calculations and threshold comparisons. `FANOUT_QUEUE_THRESHOLD` fails safe (always inline), making this a code quality issue rather than runtime critical.
- **Where:**
  - `packages/subscription/src/subscriptions/subscribe.ts:16-18`
  - `packages/subscription/src/session/index.ts:27-29`
  - `packages/subscription/src/subscriptions/do.ts:172-174`
- **How:** Use the pattern already established in core's `durable_object.ts:186-194`: `Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT`. This also guards against `Infinity` and negative values.
- **Effort:** S

#### FIX-013: Fix wrangler test config compatibility_date
- **Sources:** Review 1 (CROSS-1)
- **What:** Subscription test config uses `2025-02-02` vs core's `2026-02-02`.
- **Where:** `packages/subscription/wrangler.test.toml:3`
- **How:** Update to `2026-02-02`.
- **Effort:** S

#### FIX-020: Cleanup batch concurrency limit
- **Sources:** Review 2 (SUB-7)
- **What:** Session cleanup already batches sessions (BATCH_SIZE=10 at lines 159-166), but the inner loop per session (lines 70-83) still calls `stub.removeSubscriber` sequentially. A session subscribed to 1K+ streams triggers 1K+ sequential RPCs.
- **Where:** `packages/subscription/src/cleanup/index.ts:70-83` (inner subscription removal loop)
- **How:** Batch the inner subscription removal RPCs with `Promise.allSettled` in groups. Limit concurrent RPCs per session (max 10-50).
- **Effort:** M

#### FIX-021: URL parameter validation on DELETE routes
- **Sources:** Review 1 (SUB-2)
- **What:** `sessionId` path parameter on DELETE routes not validated.
- **Where:**
  - `packages/subscription/src/http/routes/subscribe.ts:57-65`
  - `packages/subscription/src/http/routes/session.ts:7-12`
- **How:** Add ArkType or regex validation at the route boundary.
- **Effort:** M

#### FIX-022: Metrics/logging for subscribe rollback failures
- **Sources:** Review 1 (SUB-3)
- **What:** When `addSubscriber()` fails after session stream creation, no metric or log is emitted.
- **Where:** `packages/subscription/src/subscriptions/subscribe.ts:32-49`
- **How:** Emit metric or structured log with session ID and error reason.
- **Dependencies:** FIX-011 (nice-to-have)
- **Effort:** M

### Cross-package (P1)

#### FIX-009: Extract shared JWT and auth logic
- **Sources:** Review 3 (AUTH-1)
- **What:** ~65 lines of identical JWT code in core and subscription. Security fix could be missed.
- **Where:**
  - `packages/core/src/http/auth.ts:40-136`
  - `packages/subscription/src/http/auth.ts:105-186`
- **How:** Create `packages/auth/` with shared functions and types. Update both packages to import from shared.
- **Effort:** M

#### FIX-010: Add stream_id claim to subscription JWT
- **Sources:** Review 3 (AUTH-3)
- **What:** Core supports optional `stream_id` claim; subscription doesn't.
- **Where:** `packages/subscription/src/http/auth.ts:127-131`
- **How:** Add `stream_id?: string` to ProjectJwtClaims. If FIX-009 lands first, change goes in shared package.
- **Dependencies:** FIX-009 (preferred)
- **Effort:** S

#### FIX-011: Structured logging with context
- **Sources:** Review 2 (CROSS-2), Review 3 (CQ-3, CQ-10)
- **What:** Core has zero logging. Subscription logs without context. Router catch-all silently swallows 500s.
- **Where:** Key locations: `packages/core/src/http/router.ts:78-80` (catch-all), `packages/subscription/src/cleanup/` (cleanup), `packages/subscription/src/subscriptions/do.ts` (fanout). Also all `src/` directories in both packages.
- **How:** Create lightweight structured logging utility. Deploy to: router catch-all, DO alarms, rotation, cleanup, fanout, all error paths.
- **Effort:** L

#### FIX-023: Document KV ACL requirement for REGISTRY
- **Sources:** Review 3 (AUTH-2)
- **What:** REGISTRY KV stores JWT secrets. Must have private ACL, not documented.
- **Where:** Both auth files, READMEs
- **How:** Add JSDoc comments and README "Security Requirements" section.
- **Effort:** S

#### FIX-024: Document CORS fallback behavior
- **Sources:** Review 3 (AUTH-4)
- **What:** Core and subscription handle CORS fallback differently. Should be documented.
- **Where:** Both `create_worker.ts` files, docs/
- **How:** Create `docs/cors-configuration.md`.
- **Dependencies:** FIX-001 (do after defaults fixed)
- **Effort:** S

---

## P2 — Backlog

### `packages/core`

#### FIX-029: ReadPath in-flight caches bounded
- **Where:** `packages/core/src/stream/read/path.ts:37-38`
- **How:** Add max size limits (e.g., 1000 entries) with eviction.
- **Effort:** M

#### FIX-030: inFlight Map bounded
- **Where:** `packages/core/src/http/create_worker.ts:234`
- **How:** Add max map size (e.g., 100K entries). Skip dedup when exceeded. Note: post-sentinel-removal, this is the only in-flight coalescing Map (simpler than before). Auto-cleanup is 200ms linger (line 491-495) or immediate delete (line 500). Risk is lower than originally assessed.
- **Effort:** M

#### FIX-031: Content-type parameter handling test
- **Where:** `packages/core/src/protocol/headers.ts:23-26`
- **How:** Add test: create with `application/json; charset=utf-8`, append with `application/json`. Document normalization.
- **Effort:** S

#### FIX-032: Stream-Seq semantics documented
- **Where:** `packages/core/src/stream/close.ts:27-31`
- **How:** Add inline comments. Update README.
- **Effort:** S

#### FIX-033: Producer TTL documented
- **Where:** `packages/core/src/stream/producer.ts:29`
- **How:** Document in README. Consider `Producer-TTL` response header.
- **Effort:** S

#### FIX-034: Conformance test timeout
- **Where:** `packages/core/vitest.conformance.config.ts`
- **How:** Add `testTimeout: 40_000`.
- **Effort:** S

#### FIX-035: Replace hardcoded CACHE_SETTLE_MS with poll
- **Where:** `packages/core/test/implementation/edge_cache.test.ts:9`
- **How:** Replace with polling loop (poll every 10ms, timeout 2s).
- **Effort:** M

#### FIX-043: DO operation timing instrumentation
- **Where:** `packages/core/src/protocol/timing.ts`
- **How:** Add timing to storage queries, broadcast, rotation.
- **Effort:** M

#### FIX-048: Document or remove extractBearerToken export
- **Where:** `packages/core/src/http/auth.ts:40-45`, `worker.ts:155`
- **How:** Document as public API or remove.
- **Effort:** S

### `packages/subscription`

#### FIX-036: Per-test stream cleanup in integration tests
- **Where:** `packages/subscription/test/integration/`
- **How:** Add `afterEach()` hook to delete test streams.
- **Effort:** M

#### FIX-040: Subscription response headers non-standard
- **Where:** `packages/subscription/src/http/create_worker.ts:73-81`
- **How:** Rename `X-Fanout-*` to `Stream-Fanout-*`. Update tests and README.
- **Effort:** S

#### FIX-041: Session route error inconsistency
- **Where:** `packages/subscription/src/http/routes/session.ts:11,21` (file is now 23 lines)
- **How:** Standardize to `{ error: "message", code: "CODE" }`.
- **Effort:** S

#### FIX-042: Fanout failure logging
- **Where:** `packages/subscription/src/subscriptions/do.ts:162-224`
- **How:** Log fanout results at DEBUG level. Use FIX-011 logging if available.
- **Dependencies:** FIX-011 (nice-to-have)
- **Effort:** M

#### FIX-044: Use SessionDO RPC for cleanup subscription discovery
- **What:** Cleanup was using `getSessionSubscriptions()` (Analytics Engine HTTP API) to discover a session's subscriptions. SessionDO already stores subscriptions in SQLite and exposes `getSubscriptions()` RPC — that's the source of truth.
- **Where:** `packages/subscription/src/cleanup/index.ts`, `packages/subscription/test/cleanup.test.ts`
- **How:** Replaced `getSessionSubscriptions()` call with `SessionDO.getSubscriptions()` RPC in `cleanupSession()`. Rewrote cleanup tests to use real bindings from `cloudflare:test` (real CORE, SESSION_DO, SUBSCRIPTION_DO) instead of mocks. Only `getExpiredSessions` remains mocked (Analytics Engine HTTP API unavailable in vitest pool). `API_TOKEN` is still needed for `getExpiredSessions` which queries AE for expired sessions.
- **Effort:** M

#### FIX-045: Document vitest beta version rationale
- **Where:** `packages/subscription/package.json`
- **How:** Add comment explaining the beta requirement.
- **Effort:** S

#### FIX-047: Add test for queue fallback path
- **Where:** `packages/subscription/src/subscriptions/do.ts:178-189`
- **How:** Mock queue.send() to reject, verify inline fanout works.
- **Effort:** M

### Cross-cutting

#### FIX-049: Surface actual error messages in all error responses
- **Sources:** Session debugging fix
- **What:** Many catch blocks return generic error strings (e.g., `"Failed to subscribe"`) instead of including the actual `err.message`. This makes debugging impossible — the client sees a useless message and the actual error is only in server logs (if logged at all). Already fixed in `subscribe.ts` and `publish.ts` route handlers; need to audit and fix all remaining catch blocks across both packages.
- **Where:** All `catch` blocks in route handlers and RPC methods across `packages/core/src/` and `packages/subscription/src/`
- **How:** Replace `{ error: "Generic message" }` with `{ error: err instanceof Error ? err.message : "Generic message" }` in all catch blocks that return error responses. For core, this depends on FIX-012 (JSON error format) — core currently returns `text/plain` errors, so fix the format first.
- **Dependencies:** FIX-012 (for core package)
- **Effort:** S-M

### Admin Dashboards

#### FIX-037: Replace `any` casts with TS interfaces (admin-core)
- **Where:** `packages/admin-core/src/routes/projects.$projectId.streams.$streamId.tsx:160,458`
- **How:** Define typed interfaces. Replace all `any` casts (2 remaining instances).
- **Effort:** M

#### FIX-038: Replace `Record<string, unknown>` cast with TS interface (admin-subscription)
- **Where:** `packages/admin-subscription/src/routes/projects.$projectId.sessions.$id.tsx:136`
- **How:** Define typed interface. The `as any` was already improved to `as Record<string, unknown>` but still uses manual string key lookups with fallbacks (`d.sessionId || d.session_id`). A proper typed interface would be better.
- **Effort:** S

#### FIX-039: Review React hook dependency / tokenRef pattern
- **Where:** `packages/admin-subscription/src/hooks/use-durable-stream.ts:131`
- **How:** The exclusion now has a comment: `// token intentionally excluded — tokenRef handles refresh`. Pattern is documented but still warrants review for correctness. Consider adding `token` to deps with cleanup if the current approach has edge cases.
- **Effort:** M

### Cross-package (P2)

#### FIX-026: Pin devDependency versions
- **Where:** All `package.json` files
- **How:** Replace `"latest"` with pinned caret ranges.
- **Effort:** S

#### FIX-027: Standardize tsconfig across packages
- **Where:** All `tsconfig.json` files
- **How:** Create root `tsconfig.base.json`. All packages extend it.
- **Effort:** M

#### FIX-028: Analytics SQL query builder / shared admin analytics
- **Where:** `packages/subscription/src/analytics/`, both `admin-*/src/lib/analytics.ts`
- **How:** Create shared analytics package with query builder and boilerplate.
- **Effort:** M

#### FIX-046: Extract shared test helpers
- **Where:** Core and subscription `test/` directories
- **How:** Create `packages/test-helpers/`.
- **Effort:** M

---

## Dependency Graph

```
FIX-001 (CORS defaults)
  └── FIX-024 (CORS docs — do after defaults fixed)

FIX-012 (JSON error format)
  └── FIX-009 (shared auth — standardize format before extracting)
      └── FIX-010 (stream_id claim — easier if shared auth exists)

FIX-019 (auth route parsing)
  └── FIX-009 (shared auth — fix auth.ts before extracting to avoid merge conflicts)

FIX-003 (SSE broadcast) ↔ FIX-016 (SSE clients bounded)
  Both touch realtime.ts SSE client management — sequence or combine.

FIX-011 (structured logging)
  ├── FIX-018 (WS broadcast logging — benefits from logging infra)
  ├── FIX-022 (subscribe rollback logging — benefits from logging infra)
  └── FIX-042 (fanout failure logging — benefits from logging infra)
```

Note: Dependencies are "preferred ordering" rather than hard blockers. FIX-018, FIX-022, and FIX-042 can each be implemented with `console.error` and upgraded later when FIX-011 lands.

---

## Conflict Resolutions

1. **Structured logging priority:** Review 2 placed at P2; Review 3 placed at P1. **Resolution: P1.** The router catch-all silently swallowing 500 errors is an operational blindness issue. The logging helper is foundation for FIX-018, FIX-022, FIX-042.

2. **Analytics helper scope:** Review 1 proposed subscription-only SQL builder. Review 3 proposed shared admin package. **Resolution: merged into FIX-028** — single shared package addresses both.

3. **inFlight Map severity:** Both reviews downgraded from CRITICAL to MEDIUM after validation (200ms auto-cleanup). **Resolution: P2** — defense-in-depth, not urgent.

4. **Fanout failure logging vs subscribe rollback logging:** Different failure points, same logging need. **Resolution: kept as separate items** (FIX-022, FIX-042) since they touch different code paths.

---

## Execution Order Recommendation

**Week 1 (P0s):**
1. FIX-019 (Auth route bypass — S, security-critical, quick win)
2. FIX-007 (Producer ID validation — S, security)
3. FIX-002 (Segment rotation atomicity — S, batch into same SQLite transaction)
4. FIX-008 (Replace PR preview dep — S, supply chain; address with vitest beta)
5. FIX-001 (CORS defaults — S-M, security; update test configs too)
6. FIX-005 (Fanout circuit breaker — M-L, resilience-critical)

**Week 2 (P1s, quick wins first):**
1. FIX-013 (compatibility_date — S, one-line)
2. FIX-006 (NaN guards — S, quick win)
3. FIX-025 (fire-and-forget comments — S)
4. FIX-017 (LongPollQueue bounded — S)
5. FIX-023 (KV ACL docs — S)
6. FIX-021 (URL param validation — S, regex already exists)
7. FIX-012 (JSON error format — M, prerequisite for FIX-009)
8. FIX-009 (shared auth — M-L, unblocks FIX-010; do after FIX-012 and FIX-019)
9. FIX-010 (stream_id claim — S)
10. FIX-011 (structured logging — L, foundation)
11. FIX-003 + FIX-016 (SSE broadcast + bounded — M each, do together; both touch realtime.ts)
12. FIX-004, FIX-014, FIX-015, FIX-020, FIX-022 (remaining P1 Ms)
13. FIX-024 (CORS docs — S, after FIX-001)
14. FIX-018 (WS logging — S)

**Backlog (P2s):** Prioritize by package — cluster items in the same file for efficient context switching. FIX-026 (pin versions) and FIX-027 (tsconfig) are good "first issue" candidates.

---

## Plan Validation (3 Independent Reviews)

Three independent review passes were performed on this unified plan, each examining it from a different angle: **completeness/coverage**, **priorities/dependencies/execution order**, and **technical feasibility/risk**.

### Review 1: Completeness & Coverage

**Result: All 51 source items across the three fix plans map to the 48 unified items. Zero gaps.**

The difference of 3 is accounted for by two intentional merges:
- CROSS-2 (Review 2) + CQ-3 (Review 3) + CQ-10 (Review 3) → FIX-011
- SUB-4 (Review 1) + CQ-7 (Review 3) → FIX-028

Both merges are documented in the Conflict Resolutions section and are correct.

**Minor findings:**
- FIX-011 "Where" field says "All `src/` directories" — should add the specific `router.ts:71-80` location from CQ-10 for actionability.
- FIX-037 dropped line numbers from ADMIN-1 — should restore `:150-151, 267-268, 305-306, 442`.

**No incorrect merges, no undocumented priority changes, no structural issues.**

---

### Review 2: Priorities, Dependencies & Execution Order

#### Priority Changes Recommended

| ID | Current | Recommended | Rationale |
|----|---------|-------------|-----------|
| FIX-019 | P1 | **P0** | The `pathname.includes("/subscribe")` check is an actual auth bypass. A session with ID containing "subscribe" skips auth on DELETE. This is security-critical. |
| FIX-003 | P0 | **P1** | SSE clients are internal WebSocket bridge connections, not end-user connections. The "100K clients" scenario is implausible at DO scale. Still worth fixing but not critical. |
| FIX-004 | P0 | **P1** | Segment rotation already moves data to R2. Exceeding DO storage requires rotation to be broken or unconfigured. Defense-in-depth, not critical. |
| FIX-006 | P0 | **P1** | NaN only occurs if env var is set to a non-numeric string (configuration error). The `FANOUT_QUEUE_THRESHOLD` path fails safe (always inline). Code quality issue, not runtime critical. |

#### Missing Dependencies Found

| Dependency | Reason |
|------------|--------|
| FIX-012 → FIX-009 | Error format must be standardized before extracting shared auth, or the shared package inherits inconsistency. Do FIX-012 before or alongside FIX-009. |
| FIX-019 → FIX-009 | Auth route parsing lives in subscription auth.ts. If FIX-009 extracts shared auth, it may refactor this file. Do FIX-019 first to avoid merge conflicts. |
| FIX-003 ↔ FIX-016 | Both touch `realtime.ts` SSE client management. Sequence them or do together. |
| FIX-001 → test configs | Changing CORS default from `*` to error will break tests that don't set `CORS_ORIGINS`. Both `wrangler.test.toml` files need updating. Upgrades effort from S to S-M. |

#### Effort Corrections

| ID | Plan | Corrected | Reason |
|----|------|-----------|--------|
| FIX-001 | S | S-M | Must update both packages + all test wrangler configs |
| FIX-005 | M | M-L | Circuit breaker state management (counters, timers, half-open) is non-trivial |
| FIX-009 | M | M-L | Monorepo package extraction consistently underestimated |
| FIX-014 | M | S-M | Just wrapping one `KV.delete()` in a retry loop (4 lines of code) |
| FIX-021 | M | S | `SESSION_ID_PATTERN` regex already exists in `constants.ts` |

#### Conflict Resolutions: All 4 Correct

---

### Review 3: Technical Feasibility & Risk

#### Per-P0 Feasibility

| ID | Verdict | Key Finding |
|----|---------|-------------|
| FIX-001 | **RISKY** | "Throw at startup" is **infeasible** on Cloudflare Workers — `env` is only available inside request handlers, not at module init. Must use lazy per-request validation with deprecation warning instead. |
| FIX-002 | **MISCHARACTERIZED** | The read path already avoids duplication via tier routing (`segment_start` boundary). The real fix is simpler: batch `deleteOpsThrough` into the same `storage.batch()` call as the stream update — making it atomic within SQLite. **Effort drops from L to S.** |
| FIX-003 | **FEASIBLE** | Batched `Promise.allSettled` is correct. Note: concurrent `closeSseClient` calls may interfere with Map iteration — implementation must handle carefully. Severity is overstated (SSE clients are internal bridge connections). |
| FIX-004 | **FEASIBLE** | `ctx.storage.sql.databaseSize` is the correct API. Simpler alternative: check existing `meta.segment_bytes` against a configurable threshold — no new API needed. Must document that without R2, there is no cold-storage offload. |
| FIX-005 | **FEASIBLE** | Circuit breaker as DO instance variable is straightforward. **Critical correction:** Never return 503 after a successful source write — the data is already committed. Return success with metadata indicating fanout was deferred. Workers RPC has no timeout config; must use `Promise.race` with `setTimeout`. |
| FIX-006 | **FEASIBLE** | Core already uses the pattern correctly (`Number.isFinite(parsed) && parsed > 0`). Use that pattern for consistency. |
| FIX-007 | **FEASIBLE** | Proposed regex is appropriate. Consider bumping max length from 128 to 256 for `fanout:` prefix headroom. Check conformance test suite for producer ID edge cases. |
| FIX-008 | **FEASIBLE** | `@cloudflare/vitest-pool-workers` has stable npm releases. Must test compatibility with `vitest@4.1.0-beta.1` — these two dependencies are coupled. Address together. |

#### Edge Cache Collapsing Impact

**None of the P0 fixes impact edge cache collapsing.** All are write-path, subscription-worker, or devDependency changes. The edge cache (in core's `create_worker.ts`) is untouched.

#### Risks Not in the Plan

1. **FIX-002:** R2 orphan objects — crash between R2 put and segment insert leaves orphaned R2 objects. Need periodic R2 garbage collection (separate P2 item).
2. **FIX-003:** Concurrent Map mutation during batched broadcast — `closeSseClient` deletes from the shared clients Map; needs careful handling when broadcast is concurrent.
3. **FIX-004:** No remedy without R2 — if R2 isn't configured, quota enforcement can reject writes but can't offload data. Must document R2 as required for production.
4. **FIX-005:** Source write already committed before circuit breaker fires — returning 503 is misleading. Must return success + fanout metadata.
5. **FIX-007:** May break protocol conformance if the spec doesn't restrict producer IDs. Check conformance tests.
6. **FIX-008 + vitest beta:** These are coupled dependencies — replacing one without the other may break tests.
7. **Missing P0 candidate:** No rate limiting on stream creation (PUT requests). An attacker can create millions of DOs.

---

### Consolidated Recommendations from All 3 Reviews

#### Changes to Make

1. **Elevate FIX-019 to P0** and move to Week 1 — auth bypass via substring matching is security-critical.
2. **Revise FIX-001 implementation** — "throw at startup" is infeasible on Workers. Use lazy per-request validation with deprecation warning. Update effort to S-M (must update test configs too).
3. **Revise FIX-002 approach and effort** — batch `deleteOpsThrough` into the same `storage.batch()` call instead of read-path deduplication. Effort drops from L to S. Add a separate P2 item for R2 orphan garbage collection.
4. **Downgrade FIX-003 to P1** — SSE clients are internal bridge connections, not end-user connections. 100K clients per DO is implausible.
5. **Downgrade FIX-004 to P1** — defense-in-depth, not critical given segment rotation exists. Use `meta.segment_bytes` check as simpler implementation.
6. **Downgrade FIX-006 to P1** — configuration error, not runtime critical. `FANOUT_QUEUE_THRESHOLD` fails safe.
7. **Revise FIX-005 behavior** — never return 503 after successful source write. Return success with fanout metadata.
8. **Add dependency: FIX-012 before FIX-009** — error format must be standardized before auth extraction.
9. **Add dependency: FIX-003 ↔ FIX-016** — both touch realtime.ts SSE code; sequence or combine.
10. **FIX-011:** Add specific file locations to "Where" field (`router.ts:71-80`, etc.).
11. **FIX-037:** Restore line numbers `:150-151, 267-268, 305-306, 442`.
12. **Consider adding:** Stream creation rate limiting (no limit on PUT `/v1/:project/stream/:id`).

#### Revised P0 List (After Reviews)

| ID | Title | Effort |
|----|-------|--------|
| FIX-019 | Auth route parsing — exact match (ELEVATED) | S |
| FIX-001 | CORS wildcard default (revised approach) | S-M |
| FIX-002 | Segment rotation atomicity (revised approach) | S |
| FIX-005 | Fanout circuit breaker (revised behavior) | M-L |
| FIX-007 | Producer ID pattern validation | S |
| FIX-008 | Replace GitHub PR preview dependency | S |

#### Moved to P1

| ID | Title | Reason |
|----|-------|--------|
| FIX-003 | SSE broadcast batching | DO client count bounded by CF limits |
| FIX-004 | DO storage quota | Defense-in-depth, rotation exists |
| FIX-006 | NaN guards | Config error, fails safe |

---

### Post-Sentinel-Removal Re-Validation

All 48 items were re-validated against the current codebase after the sentinel coalescing pattern was removed (commit `c75cdef`). Three parallel agents checked P0, P1, and P2 items respectively.

**Result: All 48 items remain valid. Zero items are obsolete.**

#### Sentinel-Affected Items (2 of 48)

- **FIX-030** (inFlight Map): Line shifted 259→234. Now the only in-flight coalescing Map (sentinel had a second one). Risk is *lower* post-removal. Still valid as defense-in-depth.
- **FIX-035** (CACHE_SETTLE_MS): Sentinel-specific tests are gone, but `delay(CACHE_SETTLE_MS)` pattern persists for `caches.default` and in-flight coalescing tests. Still valid.

#### Other Findings During Re-Validation

- **FIX-025**: Some sentinel-related `.catch` patterns were removed when `sentinel.ts` was deleted. Fewer instances to annotate (5 in `create_worker.ts` + 1 in `write.ts`).
- **FIX-038**: The `as any` was already improved to `as Record<string, unknown>` — lower severity, effort downgraded from M to S.
- **FIX-039**: The tokenRef exclusion now has an explanatory comment — partially addressed.
- **FIX-020**: Session batching (BATCH_SIZE=10) was already partially implemented, but the *inner loop* (per-subscription removal at lines 70-83) is still sequential. Fix description updated to target the inner loop.
- **FIX-019**: Reviewer confirmed the fix can be simpler than originally proposed — just remove the `includes()` checks entirely since the anchored regexes already prevent route overlap.

All line numbers throughout the plan have been updated to match the current source code.
