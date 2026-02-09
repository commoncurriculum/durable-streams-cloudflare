# Fix Plan from Code Review #2 (Validated)

**Findings adjusted:**
- B1 (inFlight Map): Downgraded CRITICAL → MEDIUM (200ms auto-cleanup)
- B9 (No LIMIT on ops queries): Downgraded MEDIUM → LOW (natural bounds exist)
- Added: Auth 401 vs 500 for missing REGISTRY
- Added: Subscription auth route parsing fragile

---

## PACKAGE: `packages/core`

### CORE-5: Segment rotation non-atomic (CRITICAL)
- **What:** R2.put → insertSegment → deleteOpsThrough is non-atomic. Crash between steps 2-3 causes data duplication.
- **Where:** `packages/core/src/stream/rotate.ts:79-120`
- **How:** Option A: Add deletion marker before inserting segment, apply on read. Option B: Detect and deduplicate on read. Option C: Delete ops before inserting segment (risk: data loss if segment write fails).
- **Effort:** L
- **Priority:** P0

### CORE-6: SSE broadcast is sequential (CRITICAL)
- **What:** Broadcasting to SSE clients is sequentially awaited. 100K clients × 1ms = 100s blocking the DO.
- **Where:** `packages/core/src/http/handlers/realtime.ts:421-443`
- **How:** Replace sequential `for...await` with batched `Promise.allSettled()` (groups of 100-500 clients).
- **Effort:** M
- **Priority:** P0

### CORE-7: KV cleanup not retried
- **What:** KV metadata cleanup on stream deletion is fire-and-forget with no retry.
- **Where:** `packages/core/src/http/durable_object.ts:156-160`
- **How:** Wrap KV.delete() in retry loop (max 3 attempts with backoff). On final failure, log.
- **Effort:** M
- **Priority:** P1

### CORE-8: R2 segment deletion failures silent
- **What:** R2 segment deletion runs in `waitUntil()` without error handling.
- **Where:** `packages/core/src/http/handlers/write.ts:243`
- **How:** Add error handling to catch R2.delete failures; log failures with segment key.
- **Effort:** M
- **Priority:** P1

### CORE-9: SSE clients Map unbounded
- **What:** No per-stream limit on SSE connections.
- **Where:** `packages/core/src/http/handlers/realtime.ts:69`
- **How:** Add max SSE client count (e.g., 10K). Return 503 if limit reached.
- **Effort:** M
- **Priority:** P1

### CORE-10: LongPollQueue waiters unbounded
- **What:** Waiters array grows without limit; two O(n) filters per notify.
- **Where:** `packages/core/src/http/handlers/realtime.ts:85-143`
- **How:** Add max waiter count. Optimize: replace two filters with single loop.
- **Effort:** S
- **Priority:** P1

### CORE-11: ReadPath in-flight caches unbounded
- **What:** Two Maps without size limits (100ms TTL provides some cleanup).
- **Where:** `packages/core/src/stream/read/path.ts:37-38`
- **How:** Add max size limits (e.g., 1000 entries) with LRU eviction.
- **Effort:** M
- **Priority:** P2

### CORE-12: inFlight Map bounded (MEDIUM, was CRITICAL)
- **What:** inFlight Map has 200ms auto-cleanup but no max size.
- **Where:** `packages/core/src/http/create_worker.ts:259`
- **How:** Add max map size (e.g., 100K entries) with eviction.
- **Effort:** M
- **Priority:** P2

### CORE-13: Content-type parameter handling
- **What:** `normalizeContentType()` strips parameters; could cause false 409s.
- **Where:** `packages/core/src/protocol/headers.ts:25`
- **How:** Add test case: create with `application/json; charset=utf-8`, append with `application/json`. Document behavior.
- **Effort:** S
- **Priority:** P2

### CORE-14: Stream-Seq semantics undocumented
- **What:** "Stream-Seq regression" error is unclear.
- **Where:** `packages/core/src/stream/close.ts:29`
- **How:** Add inline comments explaining semantics. Update README.
- **Effort:** S
- **Priority:** P2

### CORE-15: Producer TTL not communicated to clients
- **What:** 7-day producer state TTL not discoverable by clients.
- **Where:** `packages/core/src/stream/producer.ts:29`
- **How:** Document in README. Consider response header.
- **Effort:** S
- **Priority:** P2

### CORE-16: DO storage quota enforcement (CRITICAL)
- **What:** No warnings or limits when approaching DO storage limit.
- **Where:** `packages/core/src/stream/rotate.ts`
- **How:** Add storage usage check before accepting writes. Return 507 at 90% capacity.
- **Effort:** M
- **Priority:** P0

---

## PACKAGE: `packages/subscription`

### SUB-5: Fanout without backpressure / circuit breaker (CRITICAL)
- **What:** If queue fails, inline fanout serializes all RPCs. No circuit breaker.
- **Where:** `packages/subscription/src/subscriptions/fanout.ts:27-35`, `packages/subscription/src/subscriptions/do.ts:171-200`
- **How:** Add circuit breaker: if queue unavailable N times, reject publishes with 503 instead of inline fanout. Limit inline fanout to max 1K subscribers.
- **Effort:** M
- **Priority:** P0

### SUB-6: Auth route parsing fragile
- **What:** Substring checks (`!pathname.includes("/subscribe")`) to exclude routes.
- **Where:** `packages/subscription/src/http/auth.ts:65`
- **How:** Replace with regex: `!/\/subscribe$/.test(pathname)` for exact end-of-string match.
- **Effort:** S
- **Priority:** P1

### SUB-7: Cleanup batch concurrency
- **What:** Each cleanup removes from N subscription DOs. If session had 1K streams, that's 1K RPCs.
- **Where:** `packages/subscription/src/cleanup/index.ts:43-106`
- **How:** Batch subscription removals. Limit concurrent cleanup ops (max 10).
- **Effort:** M
- **Priority:** P1

### SUB-8: Subscription response headers non-standard
- **What:** Publish route uses `X-Fanout-*` headers vs core's `Stream-*` pattern.
- **Where:** `packages/subscription/src/http/create_worker.ts:73-81`
- **How:** Rename to `Stream-Fanout-*` prefix. Update tests and README.
- **Effort:** S
- **Priority:** P2

### SUB-9: Session route error inconsistency
- **What:** Inconsistent error shapes across routes.
- **Where:** `packages/subscription/src/http/routes/session.ts:21,43,53`
- **How:** Standardize error response shape: `{ error: "message", code: "CODE" }`.
- **Effort:** S
- **Priority:** P2

### SUB-10: No fanout failure logging
- **What:** No way to trace why specific subscribers don't receive messages.
- **Where:** `packages/subscription/src/subscriptions/do.ts:162-207`
- **How:** Log fanout results at DEBUG level with context.
- **Effort:** M
- **Priority:** P2

---

## CROSS-PACKAGE

### CROSS-2: No structured logging anywhere
- **What:** Core has zero logging. Subscription logs without context.
- **Where:** Both packages
- **How:** Create shared logging utility. Define log levels. Use structured data.
- **Effort:** L
- **Priority:** P2

### CROSS-3: No timing for DO operations
- **What:** Timing class exists but only used at edge layer, not inside DOs.
- **Where:** `packages/core/src/protocol/timing.ts`
- **How:** Add timing instrumentation to storage queries, broadcast, rotation.
- **Effort:** M
- **Priority:** P2

---

## DOCUMENTATION

### DOC-1: API_TOKEN requirement undocumented
- **Where:** `packages/subscription/wrangler.toml`, `packages/subscription/README.md`
- **How:** Add comments and README section.
- **Effort:** S
- **Priority:** P2

### DOC-2: Vitest beta version not explained
- **Where:** `packages/subscription/package.json`
- **How:** Add comment explaining why beta is needed.
- **Effort:** S
- **Priority:** P2
