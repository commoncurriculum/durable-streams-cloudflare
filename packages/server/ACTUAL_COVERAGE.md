# Actual Test Coverage Analysis

**Date**: 2025-02-12  
**Method**: File-level analysis (coverage tooling broken with vitest beta)  
**Current Coverage**: ~25% of source files have unit tests

---

## Summary

- **Total source files**: 75
- **Files with unit tests**: 18
- **Files without unit tests**: 57
- **Estimated coverage**: 25.3%

---

## ✅ Well Covered Files (18 files with unit tests)

### HTTP Layer
1. `src/http/router.ts` - Project ID pattern validation ✅
2. `src/http/worker.ts` - Worker entry point imports ✅
3. `src/http/shared/headers.ts` - Header utilities ✅ **~90%**
4. `src/http/shared/expiry.ts` - TTL/expiry logic ✅ **~85%**
5. `src/http/middleware/authentication.ts` - JWT auth ✅ **~80%**
6. `src/http/middleware/cors.ts` - CORS handling ✅ **~75%**

### Stream Operations
7. `src/http/v1/streams/shared/body.ts` - Body validation ✅ **~70%**
8. `src/http/v1/streams/shared/close.ts` - Stream closing ✅ **~80%**
9. `src/http/v1/streams/shared/offsets.ts` - Offset encoding ✅ **~85%**
10. `src/http/v1/streams/shared/stream-offsets.ts` - Offset helpers ✅ **~85%**
11. `src/http/v1/streams/shared/producer.ts` - Producer logic ✅ **~90%**
12. `src/http/v1/streams/realtime/cursor.ts` - Cursor generation ✅ **~85%**
13. `src/http/v1/streams/realtime/handlers.ts` - SSE/WS handlers ✅ **~60%**

### Storage Layer
14. `src/storage/segments.ts` - Segment encoding ✅ **~80%**
15. `src/storage/stream-do/read.ts` - Read operations ✅ **~75%**
16. `src/storage/stream-do/queries.ts` - SQL queries (partial) ✅ **~40%**

### Config
17. `src/http/v1/config/index.ts` - Config API ✅ **~70%**

---

## ❌ NOT Covered - Critical Gaps (57 files)

### Priority 1: Public API Handlers (HIGH IMPACT)

#### Stream Operations
- [ ] `src/http/v1/streams/create/http.ts` - **0%** - Stream creation endpoint
- [ ] `src/http/v1/streams/create/index.ts` - **0%** - Creation DO handler
- [ ] `src/http/v1/streams/append/http.ts` - **0%** - Append endpoint
- [ ] `src/http/v1/streams/append/index.ts` - **0%** - Append DO handler
- [ ] `src/http/v1/streams/read/http.ts` - **0%** - Read endpoint
- [ ] `src/http/v1/streams/read/index.ts` - **0%** - Read DO handler
- [ ] `src/http/v1/streams/read/path.ts` - **0%** - Read path parsing
- [ ] `src/http/v1/streams/delete/index.ts` - **0%** - Delete handler
- [ ] `src/http/v1/streams/index.ts` - **0%** - StreamDO class

#### Estuary Operations (PUB/SUB) - COMPLETELY MISSING
- [ ] `src/http/v1/estuary/publish/index.ts` - **0%** - Publish handler
- [ ] `src/http/v1/estuary/publish/fanout.ts` - **0%** - Fanout logic
- [ ] `src/http/v1/estuary/subscribe/http.ts` - **0%** - Subscribe endpoint
- [ ] `src/http/v1/estuary/subscribe/index.ts` - **0%** - Subscribe handler
- [ ] `src/http/v1/estuary/unsubscribe/http.ts` - **0%** - Unsubscribe endpoint
- [ ] `src/http/v1/estuary/unsubscribe/index.ts` - **0%** - Unsubscribe handler
- [ ] `src/http/v1/estuary/touch/http.ts` - **0%** - Touch endpoint
- [ ] `src/http/v1/estuary/touch/index.ts` - **0%** - Touch handler
- [ ] `src/http/v1/estuary/get/http.ts` - **0%** - Get info endpoint
- [ ] `src/http/v1/estuary/get/index.ts` - **0%** - Get info handler
- [ ] `src/http/v1/estuary/delete/http.ts` - **0%** - Delete endpoint
- [ ] `src/http/v1/estuary/delete/index.ts` - **0%** - Delete handler
- [ ] `src/http/v1/estuary/index.ts` - **0%** - EstuaryDO class
- [ ] `src/http/v1/estuary/stream-subscribers-do.ts` - **0%** - Subscribers helper

#### Queue Consumer
- [ ] `src/queue/fanout-consumer.ts` - **0%** - Queue message consumer

### Priority 2: Middleware (MEDIUM IMPACT)

- [ ] `src/http/middleware/authorization.ts` - **0%** - Authorization checks
- [ ] `src/http/middleware/body-size.ts` - **0%** - Body size limits
- [ ] `src/http/middleware/cache.ts` - **0%** - Cache headers
- [ ] `src/http/middleware/coalesce.ts` - **0%** - Request coalescing
- [ ] `src/http/middleware/edge-cache.ts` - **0%** - Edge cache logic
- [ ] `src/http/middleware/path-parsing.ts` - **0%** - Path extraction
- [ ] `src/http/middleware/query-validation.ts` - **0%** - Query validation
- [ ] `src/http/middleware/sse-bridge.ts` - **0%** - SSE bridging
- [ ] `src/http/middleware/timing.ts` - **0%** - Timing headers

### Priority 3: Storage Layer (MEDIUM IMPACT)

#### Durable Objects
- [ ] `src/storage/stream-do/index.ts` - **0%** - StreamDoStorage class
- [ ] `src/storage/stream-do/append-batch.ts` - **0%** - Batch append logic
- [ ] `src/storage/stream-do/read-messages.ts` - **0%** - Message reading
- [ ] `src/storage/stream-do/read-result.ts` - **0%** - Result builders
- [ ] `src/storage/estuary-do/index.ts` - **0%** - EstuaryDoStorage class
- [ ] `src/storage/estuary-do/queries.ts` - **0%** - Estuary queries
- [ ] `src/storage/stream-subscribers-do/index.ts` - **0%** - SubscribersDoStorage class
- [ ] `src/storage/stream-subscribers-do/queries.ts` - **0%** - Subscriber queries

#### Registry (possibly dead code)
- [ ] `src/storage/registry.ts` - **0%** - KV operations (15+ unused functions)
- [ ] `src/storage/index.ts` - **0%** - Barrel exports (nothing imports this)

### Priority 4: Utilities (LOW IMPACT)

- [ ] `src/util/base64.ts` - **0%** - Base64 encoding (2 functions)
- [ ] `src/http/shared/errors.ts` - **0%** - Error builders
- [ ] `src/http/shared/limits.ts` - **0%** - Limit constants
- [ ] `src/http/shared/stream-path.ts` - **0%** - Path parsing
- [ ] `src/http/shared/timing.ts` - **0%** - Timing helpers
- [ ] `src/http/v1/streams/shared/encoding.ts` - **0%** - Encoding utils
- [ ] `src/http/v1/streams/shared/etag.ts` - **0%** - ETag generation
- [ ] `src/http/v1/streams/shared/json.ts` - **0%** - JSON helpers
- [ ] `src/http/v1/streams/shared/rotate.ts` - **0%** - Rotation logic
- [ ] `src/http/v1/streams/shared/validation.ts` - **0%** - Validation
- [ ] `src/http/v1/streams/shared/index.ts` - **0%** - Shared exports
- [ ] `src/http/v1/streams/realtime/index.ts` - **0%** - Realtime exports

### Priority 5: Infrastructure (LOW PRIORITY)

- [ ] `src/constants.ts` - **0%** - Constants (some unused: isValidStreamId, DEFAULT_ANALYTICS_DATASET)
- [ ] `src/log.ts` - **0%** - Logging (unused export: getLogger)
- [ ] `src/metrics/index.ts` - **0%** - Metrics (unused export: createMetrics)

---

## Integration Test Coverage

**Good coverage** (21 test files in `test/implementation/`):
- Stream operations: create, append, read, delete
- Stream lifecycle: TTL, expiry, cleanup, abort, restart
- Concurrency: concurrent writes, producer sequencing
- R2: segment rotation, truncation, delete ops
- Edge: caching, coalescing, CDN reader key
- SSE: CRLF handling, restart behavior
- Performance: message latency
- Randomized invariants

**Missing integration tests**:
- ❌ Estuary operations (all endpoints)
- ❌ Queue consumer
- ❌ Config API edge cases
- ❌ Error response format verification

---

## Conformance Test Coverage

**Status**: ✅ EXISTS in `test/conformance/`

Uses `@durable-streams/server-conformance-tests` to verify protocol compliance.

**Action needed**: Verify all protocol requirements are covered.

---

## Recommended Approach

### Step 1: Fix Coverage Tooling
```bash
# Current issue: Istanbul provider broken with vitest 4.1.0-beta.1
# Options:
# 1. Downgrade vitest to stable
# 2. Use v8 coverage provider (requires @vitest/coverage-v8)
# 3. Use manual analysis (current approach)
```

### Step 2: Fill Critical Gaps (Priority 1)

**Integration tests for:**
1. Estuary operations (12 endpoints) - **HIGHEST PRIORITY**
2. Queue consumer
3. Stream handlers (if not covered by existing tests)

**Why integration over unit**: These are complex handlers with DO interactions, R2 operations, etc. Integration tests are more valuable.

### Step 3: Review Existing Coverage

Check if **implementation tests** already cover handlers:
```bash
# Do implementation tests call stream handlers?
grep -r "PUT.*stream" test/implementation/
grep -r "POST.*stream" test/implementation/
```

If yes, handlers may have indirect coverage. Need to measure properly.

### Step 4: Strategic Unit Tests

Only add unit tests for:
- Pure utilities that are stable and exported
- Complex logic that's hard to test via integration
- Functions with many edge cases

**Don't unit test:**
- Internal implementation that may change
- Dead code (remove first)
- Things well-covered by integration tests

---

## Action Plan

### Week 1: Fix Coverage Tooling + Dead Code
1. Fix vitest coverage reporting (switch to v8 provider)
2. Generate actual line coverage report
3. Remove dead code (see DEAD_CODE_ANALYSIS.md)

### Week 2: Integration Tests - Estuary
Add tests for all 12 estuary endpoints:
- `test/implementation/estuary/subscribe.test.ts`
- `test/implementation/estuary/unsubscribe.test.ts`
- `test/implementation/estuary/publish.test.ts`
- `test/implementation/estuary/touch.test.ts`
- `test/implementation/estuary/get.test.ts`
- `test/implementation/estuary/delete.test.ts`

### Week 3: Integration Tests - Queue + Config
- `test/implementation/queue/fanout.test.ts`
- `test/implementation/config/edge_cases.test.ts`

### Week 4: Review + Fill Gaps
1. Generate new coverage report
2. Identify remaining critical gaps
3. Add targeted unit tests (if needed)

---

## Coverage Goals

### Targets
- **Integration**: 100% of public HTTP endpoints
- **Conformance**: 100% of protocol requirements
- **Unit**: 80%+ of stable pure utilities
- **Overall line coverage**: 70%+ (after dead code removal)

### Quality Over Quantity
- ✅ Test public APIs thoroughly
- ✅ Test error paths naturally (no mocks)
- ✅ Test behavior, not implementation
- ❌ Don't chase 100% line coverage
- ❌ Don't test dead code
- ❌ Don't test private APIs

---

## How to Measure Coverage Properly

Once tooling is fixed:

```bash
# Generate HTML coverage report
pnpm -C packages/server run test:unit -- --coverage

# Open report
open packages/server/coverage/index.html

# View specific file coverage
# Shows: green (covered), red (uncovered), yellow (partially covered)
```

Look for:
- **Red lines**: Not covered at all
- **Yellow lines**: Branches not covered
- **Missing files**: Not imported by any test

Focus on covering red lines in Priority 1 files first.

---

## Notes

- Current estimate (25.3%) is **file-level**, not line-level
- Actual line coverage likely lower (handlers are complex, tests may not exercise all paths)
- Integration tests provide indirect coverage but hard to measure without tooling
- Many "uncovered" files may be tested via integration tests (need proper report)
