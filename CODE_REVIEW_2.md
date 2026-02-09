# Code Review Report #2: API Design, Scalability & Edge Cases

**Date:** 2026-02-08
**Scope:** API surface, DX, observability, scalability, resource management, edge cases
**Focus:** Angles not covered by initial bug/security review

---

## Part A: API Design, Developer Experience & Protocol Correctness

### 1. API Surface Consistency

**Finding: Strong consistency within each package, but divergent response formats between core and subscription**

**Core Package:**
- All write operations (PUT/POST/DELETE) return plain Response objects with status codes
- All read operations (GET/HEAD) return explicit headers with protocol constants
- Error responses use `errorResponse()` utility with consistent `no-store` Cache-Control
- Headers follow constants defined in `packages/core/src/protocol/headers.ts`

**Core API Status Codes (comprehensive, well-organized):**
- `400` — Malformed input (Content-Length mismatch, empty body without close, invalid offset, content-type mismatches, empty JSON arrays)
- `401` — Auth failures (missing/expired tokens, config missing)
- `403` — Forbidden (write scope required, stale producer epoch, wrong project ID)
- `404` — Stream not found
- `405` — Method not allowed
- `409` — State conflicts (stream closed, content-type mismatch, producer sequence gaps, stream TTL mismatches)
- `413` — Payload too large
- `426` — WebSocket upgrade required (for SSE fallback)
- `500` — Internal errors

**Subscription Response Shape Mismatch:**
- Subscription routes use `c.json()` returning JSON bodies, but expose non-standard headers:
  - Publish route exposes `X-Fanout-Count`, `X-Fanout-Successes`, `X-Fanout-Failures`, `X-Fanout-Mode` (`packages/subscription/src/http/create_worker.ts:73-81`)
  - These differ from core's `Stream-*` headers, creating cognitive load for API consumers
- Session routes inconsistency: `getSession` returns `404` with JSON `{ error: "Session not found" }`, but subscribe/unsubscribe errors return `500` with generic `{ error: "Failed to ..." }` (`packages/subscription/src/http/routes/session.ts:21,43,53`)

**Recommendation**: Normalize subscription response headers to use `Stream-` prefix and align error bodies with core patterns.

---

### 2. Protocol Fidelity

**Status: Strong**

**Positive Aspects:**
1. **Producer Semantics** (`packages/core/src/stream/producer.ts:31-112`): Correct epoch/seq validation, proper 403 for stale epoch with `Producer-Epoch` echo header, correct 409 for sequence gaps, duplicate detection returns 204 with proper offset encoding.
2. **Offset Encoding** (`packages/core/src/protocol/offsets.ts`): Safe integer validation with ArkType, proper readSeq/byteOffset split encoding.
3. **Long-Poll Semantics** (`packages/core/src/http/handlers/realtime.ts:84-127`): LongPollQueue implements proper timeout handling, notification logic correctly filters waiters by offset.
4. **SSE Encoding** (`packages/core/src/http/handlers/realtime.ts:136-150`): CRLF handling in line splitting, base64 encoding for binary payloads with `Stream-SSE-Data-Encoding` header.

**Potential Issues:**
- **Stream-Seq Semantics Undocumented**: The error message "Stream-Seq regression" (`packages/core/src/stream/close.ts:29`) is unclear. What constitutes a regression? The protocol spec reference is not accessible from code alone.
- **Content-Type Idempotency**: `normalizeContentType()` strips parameters. `application/json; charset=utf-8` vs `application/json` could cause false 409s if streams are created with parameters and written without.
- **Producer TTL Not Communicated**: Producer state expires after 7 days (`PRODUCER_STATE_TTL_MS` in `packages/core/src/stream/producer.ts:29`) but clients have no way to discover this. A client may think epoch 5 is still active when the server has forgotten it.

---

### 3. Developer Experience

**Core:** Strong factory pattern, pluggable auth, clear CORS handling, correct status codes.

**Auth Inconsistency:**
- `packages/core/src/http/auth.ts:176,222` — Returns 401 "unauthorized" when project config not found. Could be a misconfiguration (should be 500) vs genuinely unknown project. Lines 159-161, 205-207 correctly return 500 for missing REGISTRY binding — inconsistency between these two failure modes.
- `packages/subscription/src/http/auth.ts:65` — Route parsing uses fragile substring checks to exclude `/subscribe` and `/unsubscribe` patterns. A regex-based approach would be clearer.
- `packages/subscription/src/http/auth.ts:72-100` — `request.clone().json()` swallows parse errors silently, returning null instead of signaling malformed JSON to the auth middleware.

**Error Message Quality:**
- Core: Generic messages like "stream not found", "empty body", "content-type mismatch" (good for security, minimal info leak).
- Subscription: Inconsistent — publish uses `{ error: "Failed to publish" }` while session uses `{ error: "Session not found" }`.

---

### 4. Observability

**Analytics Engine Integration:** Good coverage in both packages.
- Core: Metrics for create/append/close operations with stream-indexed data points.
- Subscription: Comprehensive fanout metrics (subscribers, successes, failures, latency), session lifecycle events, cleanup batch metrics.
- Server-Timing headers implemented in `packages/core/src/protocol/timing.ts:38-48`.

**Gaps:**
- **No structured logging anywhere.** Core package has zero console.log/error calls. Subscription only logs in cleanup (`packages/subscription/src/cleanup/index.ts:63,77,94,97`) via `console.error()` without context (no request ID, batch ID, or session counts).
- **No timing for DO operations.** The timing class exists but is not used inside stream operations (only at the edge layer).
- **No logging for fanout failures.** If a subscriber doesn't receive a message, there's no way to trace why from logs alone.

**Recommendation:** Add structured logging factory; log fanout failures at DEBUG level; consider logging segment rotation for capacity planning.

---

### 5. Configuration & Deployment

**Wrangler Configs:**
- Core: All required bindings defined. Compatibility date current (2026-02-02). No `[env]` overrides for different environments.
- Subscription: Correct DO and service bindings. Commented-out queue config not documented. `API_TOKEN` secret required for Analytics Engine cleanup queries but not documented as required.

**Binding Hygiene:**

| Package | Binding | Type | Required | Documented |
|---------|---------|------|----------|-----------|
| core | STREAMS | DO | Yes | Yes |
| core | R2 | Bucket | Yes | Yes |
| core | REGISTRY | KV | Yes | Yes |
| core | METRICS | AE | Optional | Yes |
| subscription | CORE | Service | Yes | Yes |
| subscription | SUBSCRIPTION_DO | DO | Yes | Yes |
| subscription | SESSION_DO | DO | Yes | Yes |
| subscription | REGISTRY | KV | Yes | Unclear auth req |

---

### 6. Dependency Hygiene

**Core:** Well-pinned. `@durable-streams/server-conformance-tests: "latest"` has no version constraint — pin once released.

**Subscription:**
- `vitest: 4.1.0-beta.1` — Beta version for Cloudflare integration support. Should be documented why.
- `@cloudflare/vitest-pool-workers` — Points to a GitHub PR build (`https://pkg.pr.new/@cloudflare/vitest-pool-workers@11632`). This could fail if the PR is updated/merged.

**Security:** No vulnerable dependencies identified. ArkType's `new Function()` for JIT compilation is acceptable during worker startup.

---

### 7. Code Organization & Module Boundaries

**Status: Good.** Clear vertical slices in core (protocol → stream operations → storage → HTTP handlers). No circular imports detected. Each module has a single responsibility.

**Subscription:** Import chain `http/routes/subscribe.ts` → `subscriptions/subscribe.ts` → `session/index.ts` is clean and unidirectional. `cleanup/index.ts` imports `subscriptions/do.ts` for RPC — correct pattern.

---

### 8. Documentation Quality

**README Quality:** Both READMEs are strong — quick start guides, auth flow documentation, architecture diagrams, binding docs.

**Gaps:**
- No error response format examples (what does a 409 body look like?)
- No producer semantics explanation for API consumers
- No documentation of edge cache collapsing behavior
- Storage layer (SQLite schema, indices) has no inline comments
- WebSocket bridge logic (`packages/core/src/http/create_worker.ts:88-190`) has minimal inline comments
- No design document explaining why subscription uses two DOs (SUBSCRIPTION_DO + SESSION_DO) instead of one

---

## Part B: Scalability, Resource Management & Edge Cases

### 1. Memory Management: Unbounded Data Structures

#### CRITICAL: `inFlight` Map in Edge Worker
**File:** `packages/core/src/http/create_worker.ts:262`

The `inFlight` Map has no upper bound. Each unique long-poll URL creates a map entry that lingers for `COALESCE_LINGER_MS` (200ms). With 100K active streams × multiple concurrent readers at different offsets, the Map could consume significant memory.

**Mitigation:** Entries are cleaned up after 200ms, but there's no maximum map size or eviction policy.

#### MEDIUM: SSE Client Arrays
**File:** `packages/core/src/http/handlers/realtime.ts:69`

`SseState.clients` Map tracks all SSE connections without per-stream or global limits. Broadcasting iterates all clients with `Array.from()` which copies all references.

#### MEDIUM: LongPollQueue Waiters
**File:** `packages/core/src/http/handlers/realtime.ts:85-101`

`waiters` array can grow unbounded. On every `notify()`, two O(n) array filters run. With 10K concurrent long-poll readers, that's 10K filter operations per notification.

#### MEDIUM: ReadPath In-Flight Caches
**File:** `packages/core/src/stream/read/path.ts:37-38`

Two unbounded Maps (`inFlightReads`, `recentReads`) track concurrent and recent reads. The 100ms TTL on `recentReads` provides automatic cleanup, but no explicit eviction policy exists for pathological access patterns.

---

### 2. Concurrency & Backpressure

#### CRITICAL: SSE Broadcast is Sequential
**File:** `packages/core/src/http/handlers/realtime.ts:417-425`

Broadcasting to SSE clients is sequentially awaited. With 100K clients, if each `writeSseData()` takes 1ms, total broadcast latency is 100 seconds. This blocks the DO request handler.

**Impact:** The DO's `blockConcurrencyWhile()` ensures single-threaded write ordering. But after the write completes, the DO must broadcast to all connected clients. If that takes seconds, subsequent write requests queue, causing head-of-line blocking.

#### CRITICAL: Fanout RPC Without Backpressure
**File:** `packages/subscription/src/subscriptions/fanout.ts:27-35`

`Promise.allSettled()` awaits up to `FANOUT_BATCH_SIZE` (50) concurrent RPC calls. If a stream has 10K subscribers, that's 200 batches. If the queue is unavailable and fallback to inline fanout kicks in (`packages/subscription/src/subscriptions/do.ts:185`), the DO serializes all 10K RPCs.

#### MEDIUM: Cleanup Batch Concurrency
**File:** `packages/subscription/src/cleanup/index.ts:164-165`

Each cleanup involves removing from N subscription DOs (one per stream the session subscribed to) plus deleting the session stream. If a session subscribed to 1000 streams, that's 1000 RPC calls per cleanup. 10 concurrent cleanups = 10,000 RPCs in flight.

---

### 3. Cloudflare Resource Limits

#### CRITICAL: No DO Storage Quota Enforcement
**File:** `packages/core/src/stream/rotate.ts`

Cloudflare DOs have a storage limit. The system doesn't monitor growth or enforce limits. The `ops` table grows unbounded until segment rotation. No warnings near capacity.

#### MEDIUM: No LIMIT Clause on Ops Queries
**File:** `packages/core/src/storage/queries.ts`

`selectOpsRange()` and `selectAllOps()` can return very large result sets without SQL LIMIT. A stream with 100K messages in the hot log returns all rows at once, risking CPU timeout (Cloudflare Workers have ~50ms CPU budgets for non-DO operations).

---

### 4. Error Recovery & Idempotency

#### CRITICAL: Segment Rotation is Non-Atomic
**File:** `packages/core/src/stream/rotate.ts:79-120`

After R2.put completes, segment metadata is inserted before ops are deleted:
1. R2.put writes segment
2. `storage.insertSegment()` records metadata
3. `storage.deleteOpsThrough()` removes hot log entries

If the DO crashes between steps 2 and 3, the segment is recorded but ops remain in SQLite. Next read finds both, leading to potential data duplication.

**Fix options:**
- Delete ops BEFORE inserting segment (risk: lose data if segment write fails)
- Use a deletion marker to prevent re-reading old ops
- Detect and deduplicate on read

#### MEDIUM: KV Cleanup Not Retried
**File:** `packages/core/src/http/durable_object.ts:156-160`

When a stream expires or is deleted, KV metadata cleanup is fire-and-forget with no retry. Stale metadata could grant access to deleted streams.

#### MEDIUM: R2 Segment Deletion Failures Silent
**File:** `packages/core/src/http/handlers/write.ts:243`

R2 segment deletion runs in `waitUntil()` without verification. If delete fails, segment record is removed from SQLite but object remains in R2 as orphaned data.

---

### 5. Edge Cases in Stream Lifecycle

#### Append to Closed Stream
**File:** `packages/core/src/http/handlers/write.ts:113-149`

The closed check uses a cached `meta` object from `getStream()`. Between this check and the actual write, another request could close the stream. **However**, writes are inside `blockConcurrencyWhile()`, so DO serialization prevents this race. The validation logic is correct by infrastructure guarantee, not by its own design.

#### Read Expired Stream
**File:** `packages/core/src/http/durable_object.ts:144-150`

Expiry is checked lazily on fetch. When triggered, deletion cascades to all SSE/WebSocket clients. Concurrent SSE clients see an unexpected connection close. This is expected behavior — expired streams should close connections.

---

### 6. Subscription Scalability

#### Fanout Threshold Inflexible
**File:** `packages/subscription/src/subscriptions/do.ts:171-200`

Default threshold is 200 subscribers (hardcoded constant, configurable via env). Below threshold: inline fanout blocks the DO for 100-200ms. Above threshold: queue fanout adds latency. No adaptive tuning or circuit breaker.

If the queue fails, fallback to inline fanout for 500K subscribers would cause the DO to serialize 500K RPCs — this is the worst-case scenario.

---

### 7. Clock Skew & Time Dependencies

**Low practical risk.** Cloudflare edge nodes are NTP-synchronized (typically <100ms skew). TTL calculations use `Date.now()` without explicit skew handling, but this is acceptable for the Cloudflare runtime.

**Minor concern:** Segments inherit TTL from stream metadata at rotation time and are never re-TTL'd. If a stream's TTL is extended after rotation, old segments keep the original expiry.

---

### 8. Data Integrity

#### Segment Rotation Non-Atomicity (covered above)
Crash between R2 write and ops deletion could produce duplicate data on read.

#### DO Migration
Cloudflare DOs can be migrated between datacenters. The system relies on Cloudflare's durability guarantees with no application-level safeguards.

---

## Summary Tables

### Part A: API & DX

| Category | Status | Key Issues |
|----------|--------|-----------|
| API Consistency | Good | Subscription uses X- headers instead of Stream- |
| Protocol Fidelity | Strong | Stream-Seq undocumented; content-type parameter handling |
| Developer Experience | Mixed | Inconsistent error responses; fragile auth route parsing |
| Observability | Good with gaps | No structured logging; cleanup errors use console.error only |
| Configuration | Good | API_TOKEN requirement unclear; no env overrides |
| Dependency Hygiene | Good | Beta vitest; GitHub PR dependency for pool |
| Code Organization | Good | No circular deps; clear structure |
| Documentation | Mixed | READMEs good; inline comments sparse; design decisions hidden |

### Part B: Scalability & Edge Cases

| Category | Severity | Finding | File |
|----------|----------|---------|------|
| Memory | CRITICAL | inFlight Map unbounded | create_worker.ts:262 |
| Memory | MEDIUM | SSE clients, LongPollQueue waiters, ReadPath Maps | realtime.ts, path.ts |
| Concurrency | CRITICAL | SSE broadcast sequential, blocks DO | realtime.ts:417 |
| Concurrency | CRITICAL | Fanout without backpressure | fanout.ts:27 |
| Limits | CRITICAL | No DO storage quota enforcement | rotate.ts |
| Limits | MEDIUM | No LIMIT on ops queries | queries.ts |
| Recovery | CRITICAL | Segment rotation non-atomic | rotate.ts:79-120 |
| Recovery | MEDIUM | KV cleanup not retried; R2 delete silent | durable_object.ts:156, write.ts:243 |
| Lifecycle | OK | Closed-stream race prevented by DO serialization | write.ts:113 |
| Subscription | CRITICAL | Inline fanout doesn't scale >1K subscribers | do.ts:171-200 |
| Time | LOW | No clock skew handling (acceptable on Cloudflare) | expiry.ts |
| Integrity | MEDIUM | Segments don't re-inherit updated TTLs | rotate.ts |

### Key Recommendations

1. **Implement Map size limits** with LRU eviction for `inFlight`, `recentReads`, and SSE client maps
2. **Batch SSE broadcasts** (send to chunks of clients, not all at once)
3. **Make segment rotation atomic** via deletion markers or deduplication on read
4. **Add fanout circuit breaker** with adaptive thresholds
5. **Enforce DO storage quotas** with graceful rejection near capacity
6. **Add LIMIT clauses** to ops queries
7. **Normalize subscription API** headers and error formats to match core
8. **Add structured logging** for operational debugging
9. **Document protocol edge cases** (producer TTL, Stream-Seq semantics)
10. **Retry KV cleanup** on failure with backoff
