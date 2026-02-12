# Test Coverage - Action Plan

**Date**: 2025-02-12  
**Current Coverage**: ~25% (file-level estimate)  
**Goal**: 70%+ line coverage of public APIs

---

## 🔴 Current Problems

1. **Coverage tooling broken** - Istanbul provider crashes with vitest 4.1.0-beta.1
2. **Dead code exists** - ~15+ unused functions shouldn't be tested
3. **Estuary completely untested** - 12 endpoints with 0% coverage
4. **No line-level metrics** - Can't see which specific lines are uncovered

---

## ✅ What's Already Tested

### Well Covered (~18 files)
- ✅ HTTP shared utilities (headers, expiry, offsets)
- ✅ Producer sequencing logic
- ✅ Stream closing/TTL logic
- ✅ Cursor generation
- ✅ CORS & authentication middleware
- ✅ Segment encoding
- ✅ Read operations (partial)

### Integration Tests (21 files)
- ✅ Stream create/append/read/delete
- ✅ Concurrency & producer sequencing
- ✅ TTL/expiry/cleanup
- ✅ R2 segment operations
- ✅ Edge caching & coalescing
- ✅ SSE restart behavior

---

## ❌ Critical Gaps (0% Coverage)

### Priority 1: Estuary Operations (HIGHEST IMPACT)
**12 endpoints completely untested:**

- `/v1/estuary/:id/subscribe` - POST
- `/v1/estuary/:id/unsubscribe` - POST
- `/v1/estuary/:id/publish` - POST
- `/v1/estuary/:id/touch` - POST
- `/v1/estuary/:id` - GET (info)
- `/v1/estuary/:id` - DELETE
- Plus 6 DO handler files

### Priority 2: Queue Consumer
- `src/queue/fanout-consumer.ts` - 0%

### Priority 3: Stream Handlers
May have indirect coverage from integration tests, need to verify:
- Stream creation handler
- Append handler  
- Read handler
- Delete handler

---

## 📋 Immediate Actions

### This Week

#### 1. Fix Coverage Tooling (Day 1)
```bash
cd packages/server

# Option A: Install v8 coverage provider
pnpm add -D @vitest/coverage-v8

# Update vitest.unit.config.ts
# Change: provider: "istanbul" → provider: "v8"

# Test it works
pnpm run test:unit -- --coverage
```

#### 2. Generate Actual Coverage Report (Day 1)
```bash
pnpm run test:unit -- --coverage
open coverage/index.html

# Document:
# - Actual line coverage %
# - Red lines in priority 1 files
# - Which handlers already have indirect coverage
```

#### 3. Dead Code Decision (Day 2)
Review `DEAD_CODE_ANALYSIS.md` with team:
- Keep or remove registry functions?
- Remove unused constants/exports?

### Next 2 Weeks

#### Week 2: Estuary Integration Tests

Create 6 test files (each tests 2 endpoints):

```typescript
// test/implementation/estuary/subscribe_unsubscribe.test.ts
describe("Estuary subscribe/unsubscribe", () => {
  it("subscribes to estuary", async () => {
    const res = await fetch(`${baseUrl}/v1/estuary/${estuaryId}/subscribe`, {
      method: "POST",
      body: JSON.stringify({ sessionId: "session1" }),
    });
    expect(res.status).toBe(200);
  });

  it("unsubscribes from estuary", async () => {
    // ...
  });
});

// Similar for:
// - publish_fanout.test.ts
// - touch_keepalive.test.ts
// - get_delete.test.ts
```

#### Week 3: Queue + Verification

1. Add queue consumer test
2. Re-generate coverage report
3. Verify Priority 1 gaps filled

---

## 🎯 Success Metrics

### Coverage Targets
- ✅ **70%+ line coverage** (after dead code removal)
- ✅ **100% of public endpoints** have integration tests
- ✅ **100% of protocol** conformance
- ✅ **80%+ of pure utilities** have unit tests

### Quality Gates
- ✅ All CI checks pass
- ✅ Coverage report shows specific uncovered lines
- ✅ No tests use mocks (except Analytics Engine)
- ✅ No dead code in codebase

---

## 📊 How to Track Progress

### After Each Test Addition

```bash
# 1. Run tests with coverage
pnpm run test:unit -- --coverage

# 2. Check overall %
# Look for: "All files  | XX.X% |"

# 3. Check priority files
# Open coverage/index.html
# Navigate to src/http/v1/estuary/
# Verify % increased

# 4. Document
# Update ACTUAL_COVERAGE.md with new %
```

### Weekly Report Template

```markdown
## Week N Coverage Report

**Overall**: XX.X% (was YY.Y%, +Z.Z%)

**Priority 1**: 
- Estuary subscribe: 85% (was 0%, +85%)
- Estuary publish: 78% (was 0%, +78%)
- ...

**Files added**:
- test/implementation/estuary/subscribe.test.ts
- test/implementation/estuary/publish.test.ts

**Lines covered**: +234 lines
**Tests added**: 12 tests
**CI status**: ✅ All passing
```

---

## 🚫 What NOT To Do

❌ **Don't write unit tests for everything** - Focus on public APIs  
❌ **Don't mock Cloudflare bindings** - Use real ones  
❌ **Don't test before coverage tooling works** - You're flying blind  
❌ **Don't test dead code** - Remove it first  
❌ **Don't chase 100%** - Diminishing returns after 80%  

---

## ✅ What TO Do

✅ **Fix coverage tooling first** - You need metrics  
✅ **Focus on Priority 1 gaps** - Estuary endpoints  
✅ **Write integration tests** - They're more valuable  
✅ **Use real bindings** - `@cloudflare/vitest-pool-workers`  
✅ **Measure progress** - Generate reports after each addition  

---

## 📚 Related Documents

- **ACTUAL_COVERAGE.md** - Current coverage analysis
- **DEAD_CODE_ANALYSIS.md** - Dead code findings
- **TEST_STRATEGY.md** - Overall testing approach
- **COVERAGE_PLAN.md** - Detailed implementation plan

---

## 🤝 Next Steps

1. ✅ Coverage analysis complete
2. ⏳ **YOU ARE HERE** → Fix coverage tooling
3. ⏳ Generate actual line coverage report
4. ⏳ Team decision on dead code
5. ⏳ Add estuary tests (Priority 1)
6. ⏳ Verify 70%+ coverage achieved
