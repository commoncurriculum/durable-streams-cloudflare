# Coverage Improvement Agent Prompt

Copy this entire document and paste it into a new LLM session to work on test coverage.

---

## Your Task

Improve test coverage for the Durable Streams Cloudflare server package. Current coverage is **62.78%**, goal is **70%+**.

## ⚠️ CRITICAL: Estuary Tests Currently Failing

**Status**: 50 comprehensive estuary tests have been written but are failing with 400 Bad Request errors.

**Files Created** (in `test/implementation/estuary/`):

- `subscribe.test.ts` (11 tests)
- `unsubscribe.test.ts` (8 tests)
- `get.test.ts` (8 tests)
- `touch.test.ts` (11 tests)
- `delete.test.ts` (12 tests)

**Issue**: All estuary endpoint requests return 400 Bad Request, suggesting:

1. Request format/validation issue
2. Missing bindings in test environment
3. Path parsing middleware not working for estuary routes
4. ArkType validation failing (uses `morphFallback`)

**Next Agent Must**:

1. Debug why `/v1/estuary/subscribe/test-project/stream-id` returns 400
2. Check if auth is required (README examples show JWT tokens)
3. Verify path-parsing middleware extracts projectId/streamId correctly
4. Check test environment has all required DO namespaces (ESTUARY_DO, SUBSCRIPTION_DO)
5. Read actual error response bodies to see validation messages

## Quick Start

```bash
# Check current coverage status
cd packages/server
pnpm cov

# See uncovered lines (machine-readable)
pnpm run coverage:lines -- --zero
```

## Current Priorities

From highest to lowest impact:

1. **🔴 CRITICAL: Estuary endpoints (0% coverage)**
   - 20 files with 0% coverage
   - ~377 uncovered lines
   - Location: `src/http/v1/estuary/`
   - Need integration tests in `test/implementation/estuary/`

2. **🟠 MEDIUM: Queue consumer (0% coverage)**
   - 1 file: `src/queue/fanout-consumer.ts`
   - ~18 uncovered lines
   - Need integration test in `test/implementation/queue/`

3. **🟡 LOW: Stream operations (50-75% coverage)**
   - Append, delete, read operations need edge case tests
   - Already have basic coverage, need improvement

## Architecture Context

**Read these files first:**

- `AGENTS.md` - Development guidelines (YOU SHOULD ALREADY HAVE THIS)
- `packages/server/COVERAGE.md` - Complete coverage guide
- `packages/server/COVERAGE_QUICKSTART.md` - Quick reference

**Key facts:**

- Runtime: Cloudflare Workers + Durable Objects + R2 + SQLite
- HTTP framework: Hono v4
- Validation: ArkType v2
- Testing: Vitest with `@cloudflare/vitest-pool-workers`
- **DO NOT mock Cloudflare bindings** - use real ones

## How to Add Tests

### For Estuary Endpoints (Priority 1) - DEBUG NEEDED

**⚠️ Tests exist but are failing - see top of document for details.**

The estuary test files already exist in `test/implementation/estuary/` but need debugging:

**Correct API Format** (from README.md):

- Subscribe: `POST /v1/estuary/subscribe/:projectId/:streamId` with body `{"estuaryId":"user-123"}`
- Unsubscribe: `DELETE /v1/estuary/subscribe/:projectId/:streamId` with body `{"estuaryId":"user-123"}`
- Get: `GET /v1/estuary/:projectId/:estuaryId`
- Touch: `POST /v1/estuary/:projectId/:estuaryId`
- Delete: `DELETE /v1/estuary/:projectId/:estuaryId`

**Example Working Pattern** (from README):

```bash
curl -X POST -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $JWT" \
  -d '{"estuaryId":"user-alice"}' \
  $URL/v1/estuary/subscribe/my-project/notifications
```

**Key Points**:

1. Router uses pattern `/v1/estuary/subscribe/:estuaryPath{.+}` with `{.+}` capturing rest of path
2. Path-parsing middleware extracts projectId/streamId from path
3. HTTP handler expects `projectId` and `streamId` from context, `estuaryId` from JSON body
4. All examples in README show JWT auth - may be required

**Debug Steps**:

1. Check if authentication is required for estuary endpoints
2. Add auth header to test requests if needed
3. Read response body to see actual validation error messages
4. Verify test environment has ESTUARY_DO and SUBSCRIPTION_DO bindings
5. Check if path-parsing middleware is running for estuary routes

### For Queue Consumer (Priority 2)

Create integration test in `test/implementation/queue/`:

```typescript
// test/implementation/queue/fanout-consumer.test.ts
import { describe, it, expect } from "vitest";

describe("Queue fanout consumer", () => {
  it("processes fanout messages from queue", async () => {
    // Test queue message handling
    // Will need to trigger a publish that uses queue
  });
});
```

## Verification Workflow

After adding tests:

```bash
# 1. Run tests
cd packages/server
pnpm run test:implementation

# 2. Generate coverage
pnpm run test:coverage-all

# 3. Check improvement
pnpm run coverage:lines -- estuary

# 4. Should see increased coverage
pnpm run coverage

# 5. Verify in HTML (optional)
open coverage-combined/index.html
```

## Common Patterns

### Integration Test Structure

**Integration tests use fetch against a real running worker** (NOT Hono's test client):

```typescript
import { describe, it, expect } from "vitest";
import { createClient, uniqueStreamId } from "../helpers";

describe("Feature name", () => {
  it("tests specific behavior", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("test");

    // Arrange: create resources
    await client.createStream(streamId, "", "text/plain");

    // Act: perform operation
    const response = await fetch(client.streamUrl(streamId, { offset: "0" }));

    // Assert: verify results
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("");
  });
});
```

**Helper utilities** (from `test/implementation/helpers.ts`):

- `createClient()` - Returns client with helper methods
- `uniqueStreamId(prefix)` - Generates unique stream ID
- `client.streamUrl(id, params)` - Build stream URL
- `client.createStream(id, body, contentType)` - PUT stream
- `client.appendStream(id, body, contentType)` - POST to stream
- `client.deleteStream(id)` - DELETE stream
- `client.readAllText(id, offset)` - GET stream as text

### Content-Type Matching

**IMPORTANT**: Stream content-type must match append content-type:

```typescript
const client = createClient();
const streamId = uniqueStreamId("json-test");

// Create with JSON content-type
await client.createStream(streamId, "", "application/json");

// Append must use same content-type
await client.appendStream(
  streamId,
  JSON.stringify({ msg: "hello" }),
  "application/json", // MUST MATCH
);
```

### Unit Test Structure

**Unit tests use Hono's `app.request()` method** with `@cloudflare/vitest-pool-workers`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createStreamWorker } from "../../../src/http/worker";

describe("Feature unit test", () => {
  let worker: ReturnType<typeof createStreamWorker>;

  beforeEach(() => {
    worker = createStreamWorker();
  });

  it("tests something", async () => {
    const response = await worker.app.request(
      "/v1/stream/test",
      {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
      },
      env,
    );

    expect(response.status).toBe(201);
  });
});
```

**Pattern**: Use `worker.app.request(path, init, env)` - this is Hono's standard testing approach. The third parameter passes the Cloudflare environment bindings.

## API Endpoints Reference

**Estuary endpoints** (see `packages/server/README.md` for details):

```
POST   /v1/estuary/subscribe/:projectId/:streamId   Subscribe estuary to stream
DELETE /v1/estuary/subscribe/:projectId/:streamId   Unsubscribe estuary from stream
GET    /v1/estuary/:projectId/:estuaryId            Get estuary info
POST   /v1/estuary/:projectId/:estuaryId            Touch (refresh TTL)
DELETE /v1/estuary/:projectId/:estuaryId            Delete estuary
```

**Important**: Subscribe/unsubscribe send `{"estuaryId": "..."}` in JSON body, not in path.

## Finding Uncovered Lines

```bash
# See all uncovered lines for estuary
pnpm run coverage:lines -- estuary

# Output shows exact line numbers:
# 📄 src/http/v1/estuary/publish/index.ts
#    Coverage:    0.0%  (0/  62 lines covered)
#    Uncovered:   62 line(s)
#    Lines:     11-16, 19-23, 28-39, 48-49, 51, 61-64, ...

# Open the file and see what those lines do
cat src/http/v1/estuary/publish/index.ts
```

## Success Criteria

After your work:

- [ ] **FIX FAILING TESTS**: Debug and fix 50 existing estuary tests (currently failing with 400 errors)
- [ ] Overall coverage ≥ 70% (currently 62.78%)
- [ ] Estuary endpoints have ≥ 70% coverage (currently ~2%)
- [ ] Queue consumer has ≥ 60% coverage (currently 0%)
- [ ] All tests pass: `pnpm run test`
- [ ] All CI checks pass (see AGENTS.md for checklist)
- [ ] No new files with 0% coverage

## Testing Best Practices

✅ **DO:**

- Write integration tests for API endpoints
- Use real Cloudflare bindings via `@cloudflare/vitest-pool-workers`
- Test happy paths AND error paths
- Match content-types between stream creation and appends
- Test edge cases (empty streams, non-existent resources, etc.)

❌ **DON'T:**

- Mock Cloudflare bindings (use real ones)
- Test implementation details (test public APIs)
- Skip error paths
- Ignore the coverage report
- Test dead code (remove it instead)

## Getting Help

**If you need more context:**

1. Read the uncovered file to understand what it does
2. Check `packages/server/README.md` for API documentation
3. **Look at existing tests in `test/implementation/streams/` for patterns** - These show the actual fetch + helpers approach
4. Check `test/implementation/helpers.ts` for available test utilities
5. Check `AGENTS.md` for development guidelines
6. View the schema files in `src/http/v1/estuary/*/schema.ts` for validation rules

**Example real tests to study:**

- `test/implementation/streams/characterization.test.ts` - Integration test patterns
- `test/implementation/streams/stream_concurrency.test.ts` - Complex workflows
- `test/unit/http/middleware/cors.test.ts` - Unit test pattern (NOTE: uses older worker.fetch!() style, use app.request() for new tests)
- `test/unit/http/router.test.ts` - Pure function tests

**Coverage commands:**

```bash
pnpm cov                           # Run all + show summary
pnpm run coverage:lines            # Show uncovered lines
pnpm run coverage:lines -- --zero  # Only 0% files
open coverage-combined/index.html  # Visual report
```

## Start Here

**FIRST PRIORITY**: Fix the failing estuary tests!

1. Run `pnpm run test -- test/implementation/estuary/subscribe.test.ts` to see actual errors
2. Read the response body from failed requests to see validation error messages
3. Check if authentication is required (try adding mock JWT header)
4. Verify bindings: check `vitest.implementation.config.ts` has ESTUARY_DO and SUBSCRIPTION_DO
5. Test path parsing: add logs to see if projectId/streamId are being extracted
6. Compare with working stream tests to find differences

**AFTER fixing tests**:

1. Run `pnpm run test -- test/implementation/estuary/` to verify all pass
2. Run `pnpm cov` to see coverage improvement
3. Run `pnpm run coverage:lines -- estuary` to see what's still uncovered
4. Add tests for publish/fanout endpoint (complex, involves queue)
5. Add tests for queue consumer
6. Verify CI passes: `pnpm -r run typecheck && pnpm -C packages/server run test`

**Focus on files with 0% coverage first - biggest impact!**

## Expected Time

- **Debug existing estuary tests**: ~1-2 hours (50 tests already written, just need fixing)
- Add publish/fanout tests: ~1-2 hours (complex endpoint)
- Queue consumer test: ~30 minutes (1 file)
- Edge cases and refinement: ~1-2 hours

Total: ~4-7 hours to reach 70% coverage

## Key Learnings from Previous Attempt

1. **Path format matters**: Estuary routes use `/:estuaryPath{.+}` pattern, middleware parses into projectId/streamId
2. **Integration tests use fetch**: Real HTTP requests to live worker, NOT Hono's `app.request()`
3. **Unit tests use app.request()**: Only for testing Hono app directly without worker
4. **AUTH may be required**: README examples show JWT tokens for estuary endpoints
5. **Validation is strict**: ArkType validation with `morphFallback` - check schemas carefully
6. **Test environment**: Must have all DO bindings (STREAMS, ESTUARY_DO, SUBSCRIPTION_DO)
7. **Read response bodies**: Don't just check status codes, read error messages for debugging

---

**You have all the context you need. Start with `pnpm cov` and tackle the 0% files first!**
