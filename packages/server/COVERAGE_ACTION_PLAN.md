# Test Coverage - Action Plan

**Date**: 2025-02-12  
**Current Coverage**: **62.78% lines** (combined unit + integration)  
**Goal**: 70%+ line coverage of public APIs

---

## ✅ Coverage Tooling Status

**Coverage tooling is WORKING PERFECTLY.**

- ✅ Unit test coverage: 39.42% (340 tests, Istanbul via Vitest)
- ✅ Integration test coverage: 55.27% (Istanbul/nyc via instrumented worker)
- ✅ Combined coverage: 62.78% (merged with `nyc merge`)
- ✅ HTML reports with line-by-line highlighting
- ✅ JSON reports for tracking trends
- ✅ Console summaries with priority areas

**Quick commands**:

```bash
# Generate all coverage reports
pnpm run test:coverage-all

# View summary
pnpm run coverage

# Open interactive HTML
open coverage-combined/index.html
```

---

## 🔴 Actual Problems

1. **Estuary completely untested** - 12 endpoints with 0% coverage (~240 lines)
2. **Queue consumer untested** - 0% coverage (~50 lines)
3. **Stream operations have gaps** - append/delete/reads need better coverage
4. **SSE/realtime weak** - 47% coverage, missing edge cases

---

## ✅ What's Already Tested

### Excellent Coverage (>90%)

- ✅ Middleware: CORS, cache, authentication, authorization
- ✅ Shared utilities: expiry, headers, limits, stream paths
- ✅ Storage: registry (90%), segments (100%)
- ✅ Stream DO: queries (88%), read operations (94%)
- ✅ Producer sequencing (94%)
- ✅ Stream validation (100%)
- ✅ Cursor generation (100%)

### Good Coverage (70-90%)

- ✅ Stream reads (80%): read handlers, HTTP endpoints
- ✅ Stream creation (72%): validation, DO creation
- ✅ Stream delete (71%): cleanup logic
- ✅ Stream append (73%): basic append flow
- ✅ Edge cache middleware (91%)
- ✅ SSE bridge (79%)

---

## ❌ Critical Gaps

### Priority 1: Estuary Operations (0% coverage)

**20 files with ZERO test coverage:**

HTTP endpoints:

- `/v1/estuary/:id/subscribe` - POST (42 lines)
- `/v1/estuary/:id/unsubscribe` - POST (14 lines)
- `/v1/estuary/:id/publish` - POST (62 lines)
- `/v1/estuary/:id/touch` - POST (19 lines)
- `/v1/estuary/:id` - GET (15 lines)
- `/v1/estuary/:id` - DELETE (11 lines)

Durable Objects:

- `src/storage/estuary-do/queries.ts` (55 lines)
- `src/storage/stream-subscribers-do/queries.ts` (45 lines)
- Plus index files and HTTP handlers

**Impact**: ~240 lines of production code, entire pub/sub feature untested

### Priority 2: Queue Consumer (0% coverage)

- `src/queue/fanout-consumer.ts` - 51 lines
- **Impact**: Queue-based fanout completely untested

### Priority 3: Stream Operations - Weak Areas

- Read messages: 49% (missing edge cases)
- Realtime SSE: 47% (missing error paths)
- Path parsing: 47% (missing validation)
- JSON helpers: 28% (missing utility functions)

---

## 📋 Immediate Actions

### This Week

#### 1. ✅ DONE: Coverage Tooling Verified

- Unit tests: 39.42% coverage (340 tests passing)
- Integration tests: 55.27% coverage (Istanbul/nyc)
- Combined: 62.78% coverage (merged reports)
- HTML reports working: `open coverage-combined/index.html`
- Console summary: `pnpm run coverage`

#### 2. Add Estuary Integration Tests (Priority 1)

Create 5 test files covering 12 endpoints:

```bash
# test/implementation/estuary/subscribe_unsubscribe.test.ts
# test/implementation/estuary/publish_fanout.test.ts
# test/implementation/estuary/touch_keepalive.test.ts
# test/implementation/estuary/get_info.test.ts
# test/implementation/estuary/delete.test.ts
```

**Expected impact**: 0% → 70%+ for estuary endpoints

#### 3. Add Queue Consumer Test (Priority 2)

```bash
# test/implementation/queue/fanout-consumer.test.ts
```

**Expected impact**: 0% → 60%+ for queue consumer

### Next 2 Weeks

#### Week 2: Stream Operation Improvements

**Improve existing coverage from 50-70% to 80%+**:

1. Stream append edge cases
   - Content-type mismatches
   - Producer sequencing conflicts
   - Batch append failures
2. Stream delete edge cases
   - Delete non-existent streams
   - Delete with active subscribers
3. Read operations
   - Cursor-based pagination
   - Empty stream reads
   - R2 segment fetch failures

**Expected impact**: 73% → 85%+ for stream operations

#### Week 3: SSE and Realtime

**Improve realtime coverage from 47% to 70%+**:

1. WebSocket lifecycle tests
2. Connection error handling
3. SSE restart scenarios
4. Heartbeat/keepalive logic

**Expected impact**: 47% → 70%+ for realtime handlers

---

## 🎯 Success Metrics

### Coverage Targets

- 🟡 **70%+ line coverage** (currently 62.78%, need +7.22%)
- ❌ **100% of public endpoints** tested (Estuary at 0%)
- ✅ **100% of protocol** conformance (conformance tests passing)
- ✅ **80%+ of utilities** have tests (shared utilities at 85%)

### Quality Gates

- ✅ All CI checks pass
- ✅ Coverage reports working (unit + integration + combined)
- ✅ No mocks used (except Analytics Engine)
- ✅ HTML reports show specific uncovered lines

---

## 📊 How to Track Progress

### After Each Test Addition

```bash
# 1. Run all tests with coverage and merge
pnpm run test:coverage-all

# 2. View summary with priorities
pnpm run coverage

# 3. Check specific files in HTML
open coverage-combined/index.html
# Navigate to your file and verify green lines

# 4. Verify improvement
# Should see reduced "Files with 0%" count
# Should see increased "Overall Coverage" percentage
```

### Weekly Report Template

```markdown
## Week N Coverage Report

**Overall**: XX.XX% (was 62.78%, +Z.ZZ%)

**Priority 1 - Estuary**:

- Before: 1.8% average (20 files at 0%)
- After: YY.Y% average (N files at 0%)
- Tests added: X integration tests
- Lines covered: +NNN lines

**Priority 2 - Queue**:

- Before: 0% (51 lines uncovered)
- After: YY.Y% (NN lines uncovered)
- Tests added: 1 integration test

**Files with 0% coverage**: NN files (was 20)
**CI status**: ✅ All passing
```

---

## 🚫 What NOT To Do

❌ **Don't mock Cloudflare bindings** - Use `@cloudflare/vitest-pool-workers`  
❌ **Don't test dead code** - Remove it first  
❌ **Don't chase 100%** - Diminishing returns after 80%  
❌ **Don't test implementation details** - Test public APIs  
❌ **Don't ignore the HTML report** - It shows EXACTLY which lines are uncovered

---

## ✅ What TO Do

✅ **Run `pnpm run test:coverage-all` before every PR** - Know your impact  
✅ **Check `pnpm run coverage` summary** - See priorities at a glance  
✅ **Focus on 0% files first** - Biggest impact  
✅ **Write integration tests for endpoints** - Test full workflows  
✅ **Use real bindings** - `@cloudflare/vitest-pool-workers`  
✅ **Open HTML report** - See exact uncovered lines  
✅ **Track trends** - Compare coverage % week-over-week

---

## 📚 Related Documents

- **COVERAGE.md** - Complete coverage guide with commands and examples
- **COVERAGE_STATUS.md** - Detailed status with per-file breakdown
- `coverage-combined/index.html` - Interactive HTML report (THE MAIN REPORT)
- `scripts/coverage-summary.mjs` - Summary generator script
- `scripts/merge-coverage.mjs` - Coverage merge script

---

## 🤝 Next Steps

1. ✅ Coverage analysis complete
2. ✅ Coverage tooling verified and working
3. ✅ Combined coverage report generated (62.78%)
4. ⏳ **YOU ARE HERE** → Add estuary tests (0% → 70%)
5. ⏳ Add queue consumer test (0% → 60%)
6. ⏳ Improve stream operations (73% → 85%)
7. ⏳ Improve SSE/realtime (47% → 70%)
8. ⏳ Achieve 70%+ overall coverage (currently 62.78%)

---

## 🚀 Get Started Now

```bash
# See current status
pnpm run test:coverage-all && pnpm run coverage

# Open HTML report to see exact uncovered lines
open coverage-combined/index.html

# Focus on files with 0% coverage first (biggest impact)
```
