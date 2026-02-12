# Coverage Improvement Agent Prompt

Copy this entire document and paste it into a new LLM session to work on test coverage.

---

## Your Task

Improve test coverage for the Durable Streams Cloudflare server package. Current coverage is **62.78%**, goal is **70%+**.

## 🚨 CRITICAL: TEST-DRIVEN DEVELOPMENT REQUIRED

**YOU MUST FOLLOW THIS WORKFLOW:**

1. Write ONE test
2. Run that ONE test
3. If it fails, debug and fix it
4. If it passes, commit it
5. Move to next test

**DO NOT:**

- Write multiple tests without running them
- Assume test format without validating
- Copy-paste test patterns without verification
- Write more than 1-2 tests before running them

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

### For Estuary Endpoints (Priority 1) - TEST-DRIVEN APPROACH

**NO TESTS EXIST YET - START FROM SCRATCH**

**Step 1: Write the simplest possible test**

```typescript
// test/implementation/estuary/subscribe.test.ts
import { describe, it, expect } from "vitest";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

describe("Estuary subscribe", () => {
  it("returns something from subscribe endpoint", async () => {
    const response = await fetch(`${BASE_URL}/v1/estuary/subscribe/test-project/test-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ estuaryId: "test-estuary" }),
    });

    // Just see what we get back
    console.log("Status:", response.status);
    console.log("Body:", await response.text());
  });
});
```

**Step 2: Run ONLY that test**

```bash
cd packages/server
pnpm run test -- test/implementation/estuary/subscribe.test.ts
```

**Step 3: Debug based on actual response**

- If 401/403: Auth required (check README for JWT format)
- If 400: Validation error (read response body for error message)
- If 404: Route not found (check path format)
- If 500: Server error (check logs for stack trace)

**Step 4: Fix and iterate**

Based on what you learn, adjust the test. Only after ONE test passes, write the next one.

**API Format** (from README.md):

- Subscribe: `POST /v1/estuary/subscribe/:projectId/:streamId` with body `{"estuaryId":"user-123"}`
- Unsubscribe: `DELETE /v1/estuary/subscribe/:projectId/:streamId` with body `{"estuaryId":"user-123"}`
- Get: `GET /v1/estuary/:projectId/:estuaryId`
- Touch: `POST /v1/estuary/:projectId/:estuaryId`
- Delete: `DELETE /v1/estuary/:projectId/:estuaryId`

**Important Unknowns to Discover**:

1. Is auth required? (README shows JWT but might be optional for tests)
2. Does source stream need to exist first?
3. What bindings are needed in test env?
4. What is the actual validation error format?

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

**Estuary endpoints** (from `packages/server/README.md`):

```
POST   /v1/estuary/subscribe/:projectId/:streamId   Subscribe estuary to stream
DELETE /v1/estuary/subscribe/:projectId/:streamId   Unsubscribe estuary from stream
GET    /v1/estuary/:projectId/:estuaryId            Get estuary info
POST   /v1/estuary/:projectId/:estuaryId            Touch (refresh TTL)
DELETE /v1/estuary/:projectId/:estuaryId            Delete estuary
```

**Important**:

- Subscribe/unsubscribe send `{"estuaryId": "..."}` in JSON body
- README examples show JWT auth but it may be optional
- Test ONE endpoint at a time and actually read error responses

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

- [ ] Overall coverage ≥ 70% (currently 62.78%)
- [ ] Estuary endpoints have ≥ 70% coverage (currently ~2%)
- [ ] Queue consumer has ≥ 60% coverage (currently 0%)
- [ ] All tests pass: `pnpm run test`
- [ ] All CI checks pass (see AGENTS.md for checklist)
- [ ] No new files with 0% coverage
- [ ] Every test was run individually before writing the next one

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

**USE TEST-DRIVEN DEVELOPMENT:**

1. Run `pnpm cov` to see current coverage
2. Run `pnpm run coverage:lines -- --zero` to see 0% files
3. Pick ONE estuary endpoint (start with subscribe)
4. Create `test/implementation/estuary/subscribe.test.ts`
5. Write ONE simple test (just check status code)
6. Run ONLY that test: `pnpm run test -- test/implementation/estuary/subscribe.test.ts`
7. Read the actual error/response
8. Fix the test based on what you learned
9. Only after it passes, write the next test
10. Repeat for each endpoint

**ONE TEST AT A TIME. RUN IT. FIX IT. THEN MOVE ON.**

**After tests work**:

1. Run `pnpm cov` to see coverage improvement
2. Check what lines are still uncovered: `pnpm run coverage:lines -- estuary`
3. Add more tests for uncovered paths (but still one at a time!)
4. Verify CI passes: `pnpm -r run typecheck && pnpm -C packages/server run test`

## Expected Time

- Write and validate estuary tests (ONE AT A TIME): ~2-3 hours
- Add publish/fanout tests: ~1-2 hours (complex endpoint)
- Queue consumer test: ~30 minutes (1 file)
- Edge cases and refinement: ~1-2 hours

Total: ~5-8 hours to reach 70% coverage

## Key Learnings - CRITICAL TO FOLLOW

1. **ONE TEST AT A TIME**: Write one test, run it, fix it, commit it, then next
2. **Read actual errors**: Don't assume - read response bodies and logs
3. **Integration tests use fetch**: Real HTTP requests to live worker, NOT `app.request()`
4. **Unit tests use app.request()**: Only for testing Hono app directly without worker
5. **Test environment**: Check `vitest.implementation.config.ts` for required bindings
6. **Start simple**: First test should just check if endpoint exists (200 or 400, not 404)
7. **Iterate based on feedback**: Each test teaches you something - use that knowledge
8. **Don't batch write**: Writing 50 tests without running them = wasting time

## Previous Mistake to Avoid

**DO NOT DO THIS**: A previous agent wrote 50 estuary tests without running any of them. All 50 failed with 400 errors. This wasted time and had to be deleted.

**DO THIS INSTEAD**: Write one test → Run it → Read error → Fix it → Commit it → Next test

---

**You have all the context you need. Start with `pnpm cov` and tackle the 0% files first!**
