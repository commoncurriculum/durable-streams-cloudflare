# Test Coverage Improvement - Summary

**Date**: 2025-02-12  
**Analyzed By**: AI Agent  
**Status**: 🚧 Awaiting Team Review

## TL;DR

1. **Found dead code** - Don't test it, remove it first
2. **Coverage strategy**: Integration tests > Unit tests
3. **Missing tests**: Estuary operations, queue consumer
4. **Action needed**: Team decision on registry functions

---

## What I Did

✅ Ran test coverage analysis  
✅ Analyzed public API surface  
✅ Identified dead code (ts-prune)  
✅ Created test strategy  
✅ Documented findings  

---

## Key Findings

### Current Test Coverage

**Good** ✅:
- Core stream operations (create, append, read, delete)
- Producer sequencing
- TTL/expiry
- R2 segments
- Edge caching
- Conformance tests

**Missing** ❌:
- Estuary operations (pub/sub)
- Queue consumer (fanout)
- Some error paths

### Dead Code Found

~15+ unused exported functions in `src/storage/registry.ts`:
- `createProject`, `addSigningKey`, `removeSigningKey`
- `addCorsOrigin`, `removeCorsOrigin`
- `updatePrivacy`, `rotateStreamReaderKey`
- ... and more

**Question**: Are these planned for admin API or can we remove?

### Public API Surface

From `package.json` exports:
```typescript
export { ServerWorker, StreamDO, EstuaryDO, StreamSubscribersDO, createStreamWorker }
export type { BaseEnv, StreamIntrospection }
```

**Insight**: Most code is internal implementation, not public API!

---

## Recommendation

### Phase 0: Clean Up Dead Code (Week 1)
**Before writing tests**, remove or clearly mark unused code.

**Decision needed**: Registry functions - keep or remove?

### Phase 1: Integration Tests (Week 2)
Add missing tests for:
- Estuary operations (subscribe, publish, unsubscribe, touch, get, delete)
- Queue consumer (fanout delivery, retries)
- Error response verification

### Phase 2: Conformance Review (Week 3)
Ensure protocol compliance tests are complete.

### Phase 3: Unit Tests (Week 4 - Optional)
Only for stable, pure, exported utilities.

---

## Documents Created

1. **TEST_STRATEGY.md** - High-level approach (read first!)
2. **DEAD_CODE_ANALYSIS.md** - Detailed findings
3. **COVERAGE_PLAN.md** - Detailed test plan
4. **NEXT_STEPS.md** - Immediate actions

---

## Key Principles

### ✅ DO
- Focus on public HTTP endpoints
- Write integration tests with live workers
- Use real Cloudflare bindings
- Test behavior, not implementation

### ❌ DON'T
- Test dead code (remove it first)
- Mock Cloudflare bindings
- Aim for 100% line coverage
- Test internal implementation details

---

## Next Steps

1. **Team reviews** `DEAD_CODE_ANALYSIS.md`
2. **Decision** on registry functions (keep/remove)
3. **Clean up** dead code
4. **Write tests** following `TEST_STRATEGY.md`

---

## Questions for Team

1. Registry functions - planned admin API or dead code?
2. Target coverage %?
3. Timeline for Phase 1?
4. Who will work on this?

---

## Blocked On

🔴 Team decision on dead code before proceeding with tests.

**Why**: Don't want to test code that will be removed.

---

## References

- Project guidelines: `CLAUDE.md`
- Test configs: `vitest.*.config.ts`
- CI checks: `.github/workflows/ci.yml`
