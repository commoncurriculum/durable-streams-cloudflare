# Test Strategy Summary

**Last Updated**: 2025-02-12  
**Status**: 🚧 Planning Phase - DO NOT START TESTING YET

## Current Situation

- 39 existing test files (unit + implementation + conformance)
- Good coverage of core stream operations
- **Missing**: Estuary (pub/sub) operations, queue consumer tests
- **Problem**: Dead code in codebase that shouldn't be tested

## The Right Approach

### ❌ What NOT To Do

1. **Don't write unit tests for everything** - Most code is internal implementation
2. **Don't test dead code** - Clean up first
3. **Don't use mocks** - Use real Cloudflare bindings (except Analytics Engine)
4. **Don't test private APIs** - Focus on public surface

### ✅ What TO Do

1. **Clean up dead code first** - See `DEAD_CODE_ANALYSIS.md`
2. **Write integration tests** - Test HTTP endpoints with live workers
3. **Test public APIs only** - What users actually call
4. **Use real bindings** - `@cloudflare/vitest-pool-workers` provides these

## Public API (What to Test)

From `package.json` exports:

```typescript
// Main entry: src/http/worker.ts
export { ServerWorker }         // ← WorkerEntrypoint
export { StreamDO }              // ← Durable Object
export { EstuaryDO }             // ← Durable Object  
export { StreamSubscribersDO }   // ← Durable Object
export { createStreamWorker }    // ← Factory function
export type { BaseEnv, StreamIntrospection }
```

**What this means**: Users interact with:
- HTTP endpoints (via ServerWorker)
- Durable Objects (indirectly, via HTTP)
- Configuration (BaseEnv type)

**Test strategy**: Integration tests that call HTTP endpoints.

## Phased Approach

### Phase 0: Dead Code Cleanup (CURRENT - Week 1)

**Before writing any tests:**

1. Run dead code analysis: `npx ts-prune --project tsconfig.src.json`
2. Review findings with team
3. Remove unused exports:
   - Registry CRUD functions (createProject, addSigningKey, etc.)
   - Unused constants (isValidStreamId, DEFAULT_ANALYTICS_DATASET)
   - Unused utility exports (getLogger, createMetrics)
   - Storage barrel exports (nothing uses src/storage/index.ts)
4. Clean up package exports:
   - Remove unused ProjectEntry/StreamEntry types
   - Remove default export from worker.ts

**Deliverable**: Clean codebase with minimal public API surface.

**See**: `DEAD_CODE_ANALYSIS.md` for details.

### Phase 1: Integration Test Gaps (Week 2)

**Add missing integration tests for public endpoints:**

- [ ] Estuary operations (subscribe, unsubscribe, publish, touch, get, delete)
- [ ] Queue consumer (fanout delivery, retries)
- [ ] Config API edge cases
- [ ] Error response verification (all error codes)

**Pattern**: Live wrangler workers via `unstable_dev`

```typescript
// test/implementation/estuary/publish_fanout.test.ts
import { describe, it, expect } from "vitest";

describe("Estuary publish and fanout", () => {
  it("delivers message to all subscribers", async () => {
    const estuaryId = `test-${crypto.randomUUID()}`;
    
    // Create estuary
    await fetch(`${baseUrl}/v1/estuary/${estuaryId}`, { method: "PUT" });
    
    // Subscribe
    await fetch(`${baseUrl}/v1/estuary/${estuaryId}/subscribe`, {
      method: "POST",
      body: JSON.stringify({ sessionId: "session1" }),
    });
    
    // Publish
    await fetch(`${baseUrl}/v1/estuary/${estuaryId}/publish`, {
      method: "POST",
      body: JSON.stringify({ data: "test" }),
    });
    
    // Verify delivery (implementation-specific)
  });
});
```

**Deliverable**: 100% coverage of public HTTP endpoints.

### Phase 2: Conformance Tests (Week 3)

**Ensure protocol compliance:**

- Review existing conformance tests in `test/conformance/`
- Verify all Durable Streams protocol requirements are tested
- Add any missing protocol tests

**Deliverable**: 100% protocol conformance.

### Phase 3: Pure Function Unit Tests (Week 4 - Optional)

**Only if functions are:**
- ✅ Stable (won't change)
- ✅ Pure (no side effects)
- ✅ Exported (part of public or semi-public API)
- ✅ Complex (worth testing in isolation)

**Candidates** (review after cleanup):
- `src/util/base64.ts` - if kept
- `src/http/shared/expiry.ts` - already tested ✅
- `src/http/shared/headers.ts` - already tested ✅
- `src/http/v1/streams/shared/*` - already tested ✅

**Pattern**: Real bindings via `@cloudflare/vitest-pool-workers`

```typescript
// test/unit/util/example.test.ts
import { describe, it, expect } from "vitest";
import { pureFunction } from "../../../src/util/example";

describe("pureFunction", () => {
  it("handles normal case", () => {
    expect(pureFunction("input")).toBe("output");
  });
});
```

**Deliverable**: 80%+ coverage of stable pure utilities.

## Testing Principles

### Use Real Bindings, Not Mocks

```typescript
✅ DO THIS:
import { env } from "cloudflare:test";
const id = env.STREAMS.idFromName("test");
const stub = env.STREAMS.get(id);

❌ NOT THIS:
const mockStreams = { get: vi.fn() };
```

**Why**: Mocks drift from reality. Real bindings catch real bugs.

**Exception**: `env.METRICS.writeDataPoint()` - unavailable in vitest pool workers.

### Test Behavior, Not Implementation

```typescript
✅ DO THIS:
it("returns 409 when content-type mismatches stream", async () => {
  await createStream("test", { contentType: "application/json" });
  const res = await append("test", "text/plain", "data");
  expect(res.status).toBe(409);
});

❌ NOT THIS:
it("calls validateContentType and returns error", async () => {
  const spy = vi.spyOn(validator, "validateContentType");
  // ... test implementation details
});
```

### Integration Over Unit

When in doubt, write an integration test.

**Why**:
- Tests what users experience
- Catches integration bugs
- Less brittle (survives refactoring)
- Uses real bindings

**When to write unit tests**:
- Pure utility function (e.g., base64 encoding)
- Complex logic that's hard to test via integration
- Need to test many edge cases quickly

## Success Metrics

### Coverage Targets

- **Integration tests**: 100% of public HTTP endpoints
- **Conformance tests**: 100% of protocol requirements
- **Unit tests**: 80%+ of stable pure utilities

### Quality Gates (CI)

All of these must pass before merge:

```bash
pnpm -r run typecheck        # TypeScript compile
pnpm -C packages/server run lint          # oxlint
pnpm -C packages/server run format:check  # oxfmt
pnpm -C packages/server run test:unit     # Unit tests
pnpm -C packages/server run conformance   # Protocol tests
pnpm -C packages/server run test          # Integration tests
```

## Running Tests

```bash
# Unit tests only (fast)
pnpm -C packages/server run test:unit

# Integration tests (live workers)
pnpm -C packages/server run test:implementation

# Conformance tests
pnpm -C packages/server run conformance

# All tests
pnpm -C packages/server run test

# CI parity check (run before pushing)
pnpm -r run typecheck
pnpm -C packages/server run lint
pnpm -C packages/server run test:unit
pnpm -C packages/server run conformance
pnpm -C packages/server run test
```

## Next Steps

### This Week (Week 1)

1. ✅ Run dead code analysis
2. ✅ Document findings
3. ⏳ Review with team
4. ⏳ Remove dead code
5. ⏳ Update exports

### Next Week (Week 2)

1. Add estuary integration tests
2. Add queue consumer tests
3. Verify error response coverage
4. Run full test suite

### Future (Week 3+)

1. Review conformance test coverage
2. Add unit tests for stable utilities (if needed)
3. Document coverage gaps (if any)
4. Set up coverage reporting in CI

## References

- **Dead Code Analysis**: See `DEAD_CODE_ANALYSIS.md`
- **Detailed Coverage Plan**: See `COVERAGE_PLAN.md`
- **Project Guidelines**: See `CLAUDE.md`
- **CI Configuration**: See `.github/workflows/ci.yml`

## Questions?

Ask in team chat or file an issue. Key decisions needed:

1. Remove registry CRUD functions or keep for planned admin API?
2. Target coverage percentage?
3. Timeline for Phase 1 integration tests?
