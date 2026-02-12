# Test Coverage Improvement Plan

## Overview

This plan focuses on:

1. **Public APIs** - Test what users interact with
2. **Refactoring opportunities** - Identify dead code before testing
3. **Real bindings only** - No mocks except documented exceptions

## Public API Surface

From `package.json` exports:

- **Main entry**: `src/http/worker.ts`
  - `ServerWorker` - WorkerEntrypoint class
  - `StreamDO`, `EstuaryDO`, `StreamSubscribersDO` - Durable Objects
  - `createStreamWorker()` - Factory function
  - Types: `BaseEnv`, `StreamIntrospection`, `ProjectEntry`, `StreamEntry`

### What This Means for Testing

**Focus areas:**

1. HTTP endpoints (integration tests) - what users call
2. Durable Object behavior (integration tests) - what users interact with
3. Internal utilities (unit tests) - but only if they need refactoring first

**Don't test:**

- Internal implementation details that may change
- Code that will be refactored/removed
- Non-exported functions (unless they're complex and stable)

---

## Phase 0: Dead Code Analysis & Refactoring (CURRENT)

Before writing tests, identify what should be removed or refactored.

### Dead Code Candidates (from ts-prune)

#### Constants (`src/constants.ts`)

- [ ] `isValidStreamId` - unused, consider removing or making internal
- [ ] `isValidProjectId` - unused, consider removing or making internal
- [ ] `DEFAULT_ANALYTICS_DATASET` - unused

#### Logging (`src/log.ts`)

- [ ] `getLogger` - unused export

#### Metrics (`src/metrics/index.ts`)

- [ ] `createMetrics` - unused export

#### Storage Re-exports (`src/storage/index.ts`)

Many exports are never used externally. Consider:

- [ ] Remove barrel exports that aren't part of public API
- [ ] Keep only what `worker.ts` needs to export
- [ ] Move internal APIs to non-exported modules

**Registry functions** (exported but unused):

- `createProject`, `addSigningKey`, `removeSigningKey`
- `addCorsOrigin`, `removeCorsOrigin`
- `updatePrivacy`, `rotateStreamReaderKey`
- `putStreamMetadata`, `putProjectEntry`
- `getProjectEntry`, `getStreamEntry`, `deleteStreamEntry`
- `listProjects`, `listProjectStreams`

These look like they were planned for an admin API but aren't used. Options:

1. Remove if truly unused
2. Move to separate admin module if planned feature
3. Keep if needed by DO internals (check usage)

#### Action Items

1. **Run usage analysis**:

   ```bash
   # Check if registry functions are used internally
   grep -r "createProject\|addSigningKey" packages/server/src/
   ```

2. **Review with team**: Are these planned features or dead code?

3. **Refactor before testing**: Don't write tests for code that will be removed

---

## Phase 1: Integration Test Coverage (Week 1-2)

**Goal**: Ensure all HTTP endpoints have integration tests.

### Current Integration Test Coverage

✅ **Well covered:**

- Stream operations: create, append, read, delete
- Stream lifecycle: TTL, expiry, cleanup
- Concurrency & consistency
- R2 segment operations
- Edge caching & request coalescing
- SSE restart behavior
- Producer sequencing

❌ **Missing integration tests:**

#### Estuary Operations

- [ ] `test/implementation/estuary/create_estuary.test.ts`
  - Create estuary
  - Verify metadata stored
  - Test idempotency

- [ ] `test/implementation/estuary/subscribe_unsubscribe.test.ts`
  - Subscribe to estuary
  - Unsubscribe from estuary
  - Verify session tracking
  - Test subscription cleanup

- [ ] `test/implementation/estuary/publish_fanout.test.ts`
  - Publish to estuary
  - Verify fanout to subscribers
  - Test queue delivery
  - Verify message ordering

- [ ] `test/implementation/estuary/touch_keepalive.test.ts`
  - Touch subscription to extend TTL
  - Verify session stays alive
  - Test expiry after no touch

- [ ] `test/implementation/estuary/get_info.test.ts`
  - Get estuary info
  - Verify subscriber counts
  - Test metadata accuracy

#### Queue Consumer

- [ ] `test/implementation/queue/fanout_consumer.test.ts`
  - Send message to queue
  - Verify delivery to subscriber
  - Test retry logic
  - Test batch processing

#### Error Paths

- [ ] `test/implementation/errors/error_responses.test.ts`
  - Verify all error codes return correct status
  - Test error response format
  - Verify no stack traces leak in production errors

#### Config API

- [ ] `test/implementation/config/config_endpoint.test.ts`
  - Test config retrieval
  - Verify JWT validation
  - Test CORS configuration

### Pattern for Integration Tests

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { testClient } from "../helpers";

describe("Estuary Operations", () => {
  beforeAll(async () => {
    // Workers started by global-setup.ts
  });

  it("publishes to estuary and fans out to subscribers", async () => {
    const client = testClient();
    const estuaryId = `test-${crypto.randomUUID()}`;

    // Create estuary
    const createRes = await client.createEstuary(estuaryId);
    expect(createRes.status).toBe(201);

    // Subscribe
    const subRes = await client.subscribe(estuaryId, "session1");
    expect(subRes.status).toBe(200);

    // Publish
    const pubRes = await client.publish(estuaryId, { data: "test" });
    expect(pubRes.status).toBe(204);

    // Verify fanout (implementation-specific)
    // May need to poll subscriber or check queue
  });
});
```

---

## Phase 2: Unit Test Coverage - Pure Functions (Week 3)

**Goal**: Test stable, pure utility functions that are unlikely to change.

### Candidates for Unit Tests

#### High Value (stable, pure, used frequently)

- [ ] `src/util/base64.ts` ✅ DONE
- [ ] `src/http/shared/errors.ts` ✅ DONE (but needs CORS header fix)
- [ ] `src/http/shared/headers.ts` ✅ DONE
- [ ] `src/http/shared/expiry.ts` ✅ DONE
- [ ] `src/http/v1/streams/shared/body.ts` ✅ DONE
- [ ] `src/http/v1/streams/shared/close.ts` ✅ DONE
- [ ] `src/http/v1/streams/shared/offsets.ts` ✅ DONE
- [ ] `src/http/v1/streams/shared/producer.ts` ✅ DONE

#### Medium Value (may need refactoring first)

- [ ] `src/http/shared/limits.ts` - Review if needed
- [ ] `src/http/shared/stream-path.ts` - Check usage
- [ ] `src/http/shared/timing.ts` - Review API
- [ ] `src/http/v1/streams/shared/encoding.ts` - Check if stable
- [ ] `src/http/v1/streams/shared/etag.ts` - Review usage
- [ ] `src/http/v1/streams/shared/json.ts` - Check if needed
- [ ] `src/http/v1/streams/shared/rotate.ts` - May be internal only
- [ ] `src/http/v1/streams/shared/validation.ts` - Review scope

#### Low Priority (internal or may be removed)

- [ ] `src/storage/segments.ts` ✅ DONE - but is it public API?
- [ ] `src/storage/registry.ts` - May be removed/refactored
- [ ] `src/constants.ts` - Only if functions are kept

### Decision Framework

Before writing unit tests for a module, ask:

1. **Is it exported from the public API?** If no, skip or mark for refactoring.
2. **Is it stable?** If it's likely to change, write integration tests instead.
3. **Is it pure?** If it has side effects, test via integration.
4. **Is it complex?** If it's trivial (1-2 lines), skip.

---

## Phase 3: Storage Layer Tests (Week 4)

**Goal**: Test storage layer with real DO bindings.

### Approach

Use `@cloudflare/vitest-pool-workers` with real storage:

```typescript
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { withStorage } from "../../helpers";

describe("StreamDoStorage", () => {
  it("inserts and retrieves stream metadata", async () => {
    await withStorage("test", async (storage) => {
      await storage.insertStream({
        streamId: "test-stream",
        contentType: "application/json",
        closed: false,
        isPublic: true,
        ttlSeconds: null,
        expiresAt: null,
        createdAt: Date.now(),
      });

      const meta = await storage.getStreamMeta("test-stream");
      expect(meta).toBeDefined();
      expect(meta?.stream_id).toBe("test-stream");
    });
  });
});
```

### Files to Test (if not refactored)

- [ ] `src/storage/stream-do/queries.ts` - SQL operations
- [ ] `src/storage/estuary-do/queries.ts` - Estuary queries
- [ ] `src/storage/stream-subscribers-do/queries.ts` - Subscriber queries
- [ ] `src/storage/stream-do/append-batch.ts` - Batch logic
- [ ] `src/storage/stream-do/read-messages.ts` - Read logic

**However**: These may be better tested via integration tests that exercise the full DO.

---

## Phase 4: Middleware Tests (Week 5)

**Goal**: Test middleware with real Hono contexts.

### Current Coverage

✅ **Covered:**

- `cors.ts` ✅
- `authentication.ts` ✅

❌ **Not covered:**

- [ ] `authorization.ts`
- [ ] `body-size.ts`
- [ ] `cache.ts`
- [ ] `coalesce.ts`
- [ ] `edge-cache.ts`
- [ ] `path-parsing.ts`
- [ ] `query-validation.ts`
- [ ] `sse-bridge.ts`
- [ ] `timing.ts`

### Decision

**Recommendation**: Test these via integration tests, not unit tests.

Middleware is best tested in context:

- Does auth middleware block unauthorized requests? (integration test)
- Does body-size middleware reject large payloads? (integration test)
- Does edge-cache middleware cache responses? (integration test)

Unit testing middleware in isolation requires too much mocking and doesn't test what matters.

---

## Phase 5: Conformance Tests (Ongoing)

**Goal**: Ensure protocol compliance.

### Current State

Conformance tests exist: `test/conformance/`

These test the Durable Streams protocol implementation.

**Action**: Ensure conformance tests pass and cover all protocol requirements.

---

## Testing Principles

### ✅ DO Write Tests For

1. **Public HTTP APIs** - via integration tests
2. **Stable pure functions** - via unit tests with real bindings
3. **Protocol compliance** - via conformance tests
4. **Error handling** - via integration tests that trigger errors naturally

### ❌ DON'T Write Tests For

1. **Internal implementation details** - they may change
2. **Dead code** - remove it first
3. **Trivial functions** - not worth the maintenance
4. **Code that needs refactoring** - refactor first, test after

### 🚫 NO MOCKS Except

1. **Analytics Engine** - `env.METRICS.writeDataPoint()` unavailable in vitest pool
2. **Failure injection** - When testing error handling for conditions impossible to trigger naturally
3. **External services** - If any (currently none)

### ✅ ALWAYS Use Real Bindings

- `env.STREAMS.get(id)` - Real DO stub
- `env.R2.get(key)` - Real R2 binding
- `env.REGISTRY.get(key)` - Real KV binding
- `runInDurableObject(stub, fn)` - Real DO execution
- `caches.default` - Real Cache API

---

## Success Metrics

### Coverage Targets

- **Integration tests**: 100% of public endpoints
- **Unit tests**: 80%+ of pure utility functions
- **Conformance tests**: 100% of protocol requirements

### Quality Gates

- ✅ All CI checks pass (typecheck, lint, format, tests)
- ✅ No mocks except documented exceptions
- ✅ Tests use real Cloudflare bindings
- ✅ Integration tests use live workers
- ✅ Test names describe behavior, not implementation
- ✅ No dead code in codebase

---

## Next Steps

### Week 1: Dead Code Cleanup

1. Run usage analysis on suspected dead code
2. Review with team
3. Remove or refactor before writing tests
4. Update exports to match actual public API

### Week 2: Integration Test Gaps

1. Add estuary operation tests
2. Add queue consumer tests
3. Add config API tests
4. Verify all error codes tested

### Week 3: Pure Function Unit Tests

1. Review which utilities are stable and public
2. Add unit tests for stable, exported utilities
3. Skip internal or unstable code

### Week 4: Storage Layer Tests

1. Decide: unit tests or integration tests?
2. Focus on query correctness
3. Use real DO storage bindings

### Week 5: Review & Refine

1. Run full coverage report
2. Identify remaining gaps
3. Prioritize high-value tests
4. Document any intentional gaps

---

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

---

## Notes

- **Public API first**: Test what users interact with
- **Refactor before testing**: Don't test code that will be removed
- **Integration over unit**: When in doubt, write an integration test
- **Real bindings only**: No mocks unless absolutely necessary
- **Behavior over coverage**: 100% coverage of bad code is still bad
