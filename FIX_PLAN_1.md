# Fix Plan from Code Review #1 (Validated)

**Findings removed after validation:**
- Finding 1 (Duplicate comment): REFUTED — comments are different
- Finding 9 (SSE timer cleanup): REFUTED — timer IS properly cleaned up
- Finding 16 (Browser teardown): REFUTED — intentional documented patterns

**Findings adjusted:**
- Finding B1 (inFlight Map): Downgraded CRITICAL → MEDIUM (200ms auto-cleanup exists)

---

## PACKAGE: `packages/subscription`

### SUB-1: Add `Number.isNaN()` guards after `parseInt` on environment variables
- **What:** Prevent silent propagation of `NaN` from invalid numeric env vars
- **Where:**
  - `packages/subscription/src/subscriptions/subscribe.ts:16-18` (`SESSION_TTL_SECONDS`)
  - `packages/subscription/src/session/index.ts:27-29` (`SESSION_TTL_SECONDS`)
  - `packages/subscription/src/subscriptions/do.ts:172-174` (`FANOUT_QUEUE_THRESHOLD`)
- **How:** After each `Number.parseInt()` call, add: `if (Number.isNaN(parsed)) parsed = DEFAULT;`
- **Effort:** S
- **Priority:** P0

### SUB-2: Add URL parameter validation on DELETE routes
- **What:** Validate `sessionId` path parameter at the boundary (defense-in-depth)
- **Where:**
  - `packages/subscription/src/http/routes/subscribe.ts:57-65` (DELETE `/session/:sessionId`)
  - `packages/subscription/src/http/routes/session.ts:7-12`
- **How:** Add ArkType or manual regex validation for `sessionId` before passing to handlers
- **Effort:** M
- **Priority:** P1

### SUB-3: Add metrics/logging for subscribe rollback failures
- **What:** Track when `addSubscriber()` fails after session stream creation
- **Where:** `packages/subscription/src/subscriptions/subscribe.ts:32-49` (catch block)
- **How:** Emit a metric or log with session ID and error reason
- **Effort:** M
- **Priority:** P1

### SUB-4: Create analytics SQL query builder helper
- **What:** Centralize validated value → SQL interpolation to reduce injection risk
- **Where:** New file `packages/subscription/src/analytics/query-builder.ts`; update `packages/subscription/src/analytics/index.ts`, both admin analytics files
- **How:** Helper accepts pre-validated inputs and returns interpolated SQL
- **Effort:** M
- **Priority:** P2

---

## PACKAGE: `packages/core`

### CORE-1: Add WebSocket broadcast error logging
- **What:** Log deserialization errors during WebSocket broadcast
- **Where:** `packages/core/src/http/handlers/realtime.ts` (catch block in broadcast)
- **How:** Add `console.error()` with context (stream ID, error details)
- **Effort:** S
- **Priority:** P1

### CORE-2: Add conformance test timeout
- **What:** Set explicit `testTimeout` in conformance vitest config
- **Where:** `packages/core/vitest.conformance.config.ts`
- **How:** Add `testTimeout: 40_000` to match implementation tests
- **Effort:** S
- **Priority:** P2

### CORE-3: Replace hardcoded CACHE_SETTLE_MS with poll-and-check
- **What:** Replace timing-dependent test assertions with polling loops
- **Where:** `packages/core/test/implementation/edge_cache.test.ts:9`
- **How:** Poll cache until entry appears (with timeout) instead of fixed 100ms wait
- **Effort:** M
- **Priority:** P2

### CORE-4: Add per-test stream cleanup in subscription integration tests
- **What:** Delete test-created streams after each test
- **Where:** `packages/subscription/test/integration/` test files
- **How:** Add `afterEach()` hook that deletes streams created via `uniqueStreamId()`
- **Effort:** M
- **Priority:** P2

---

## CROSS-PACKAGE

### CROSS-1: Fix wrangler test config compatibility_date mismatch
- **What:** Align `compatibility_date` across all test configs
- **Where:** `packages/subscription/wrangler.test.toml:3` (currently `2025-02-02`, should be `2026-02-02`)
- **How:** Update to match core's `2026-02-02`
- **Effort:** S
- **Priority:** P1

---

## PACKAGE: `packages/admin-core`

### ADMIN-1: Replace `any` casts with proper TypeScript interfaces
- **What:** Add typed interfaces for server function responses
- **Where:** `packages/admin-core/src/routes/projects.$projectId.streams.$streamId.tsx:150-151, 267-268, 305-306, 442`
- **How:** Define interfaces matching server function return types, replace `any` casts
- **Effort:** M
- **Priority:** P2

---

## PACKAGE: `packages/admin-subscription`

### ADMINSUB-1: Replace `any` cast with proper TypeScript interface
- **Where:** `packages/admin-subscription/src/routes/projects.$projectId.sessions.$id.tsx:117`
- **How:** Define interface matching server function return type
- **Effort:** M
- **Priority:** P2

### ADMINSUB-2: Review React hook dependency / tokenRef pattern
- **Where:** `packages/admin-subscription/src/hooks/use-durable-stream.ts:128`
- **How:** Either add `token` to dependencies with cleanup, or document the assumption
- **Effort:** M
- **Priority:** P2
