# Coverage Improvement Agent Prompt

## Objective

Increase test coverage from 62.78% to 70%+ by writing integration tests for estuary endpoints.

## Critical Constraint: Iterative Testing Required

Algorithm:

1. Write single test function
2. Execute: `pnpm run test -- <test-file-path>`
3. Parse output (status codes, error messages, logs)
4. If fail: debug based on actual error, modify test, goto 2
5. If pass: commit, goto 1 for next test

Constraint: Maximum 1 test written before execution. Writing multiple tests without running = failure mode.

## Initial Assessment Commands

```bash
cd packages/server
pnpm cov                              # Current coverage metrics
pnpm run coverage:lines -- --zero     # Files with 0% coverage
```

## Target Files (Priority Order)

Priority 1 (0% coverage, ~377 lines):

- `src/http/v1/estuary/subscribe/index.ts` (42 lines)
- `src/http/v1/estuary/publish/index.ts` (62 lines)
- `src/http/v1/estuary/unsubscribe/index.ts` (14 lines)
- `src/http/v1/estuary/get/index.ts` (15 lines)
- `src/http/v1/estuary/touch/index.ts` (19 lines)
- `src/http/v1/estuary/delete/index.ts` (11 lines)
- Related HTTP handlers and DO files

Priority 2 (0% coverage, ~18 lines):

- `src/queue/fanout-consumer.ts`

Priority 3 (50-75% coverage):

- Stream operations (lower priority due to existing coverage)

## Technical Context

Runtime: Cloudflare Workers + Durable Objects (SQLite) + R2 + Analytics Engine
Framework: Hono v4 (HTTP), ArkType v2 (validation)
Test Framework: Vitest + `@cloudflare/vitest-pool-workers`
Test Type: Integration tests use `fetch()` against live worker started by `global-setup.ts`
Bindings: Real Cloudflare bindings required (no mocking)

Reference files:

- `packages/server/AGENTS.md` - Development constraints
- `packages/server/src/http/middleware/path-parsing.ts` - Request routing logic
- `packages/server/src/http/router.ts` - Route definitions
- `test/implementation/helpers.ts` - Test utilities

## Test Implementation Protocol

### Phase 1: Discovery Test (Estuary Subscribe Endpoint)

Create: `test/implementation/estuary/subscribe.test.ts`

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

Execute: `pnpm run test -- test/implementation/estuary/subscribe.test.ts`

Parse output:

- Status code analysis:
  - 401/403 → Auth required, read README for JWT format
  - 400 → Parse response body for validation error details
  - 404 → Path incorrect, verify route pattern
  - 500 → Read error logs for stack trace
  - 200/201 → Success, analyze response structure

Debugging decision tree:

1. Read response.text() to get error message
2. Check wrangler logs for server-side errors
3. Compare with working stream tests in `test/implementation/streams/`
4. Verify bindings in `vitest.implementation.config.ts`

API endpoints (from `packages/server/README.md`):

```
POST   /v1/estuary/subscribe/:projectIdAndStreamId  Body: {"estuaryId":"string"}
DELETE /v1/estuary/subscribe/:projectIdAndStreamId  Body: {"estuaryId":"string"}
GET    /v1/estuary/:projectId/:estuaryId
POST   /v1/estuary/:projectId/:estuaryId
DELETE /v1/estuary/:projectId/:estuaryId
```

Discovery objectives:

1. Determine if JWT auth required for test environment
2. Determine if source stream must exist before subscription
3. Identify required DO namespace bindings
4. Map validation error response format

### Phase 2: Queue Consumer (After Estuary Tests Pass)

Path: `test/implementation/queue/fanout-consumer.test.ts`
Approach: Trigger publish that exceeds inline fanout threshold, verify queue processing
Prerequisites: Working subscribe + publish endpoints

## Coverage Verification

After each passing test:

```bash
cd packages/server
pnpm cov                                # Full coverage report
pnpm run coverage:lines -- estuary     # Specific file coverage
```

Post-completion verification:

```bash
pnpm -r run typecheck                  # Type safety
pnpm -C packages/server run lint       # Code quality
pnpm -C packages/server run test       # All tests pass
```

## Test Pattern Reference

Integration test structure (fetch against live worker):

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

Available utilities (`test/implementation/helpers.ts`):

```typescript
createClient()                              // Returns client object
uniqueStreamId(prefix)                      // UUID-based stream ID
client.streamUrl(id, params?)               // Constructs URL
client.createStream(id, body, contentType)  // PUT /v1/stream/:id
client.appendStream(id, body, contentType)  // POST /v1/stream/:id
client.deleteStream(id)                     // DELETE /v1/stream/:id
client.readAllText(id, offset)              // GET /v1/stream/:id
```

Content-type constraint:

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

Unit test structure (NOT used for estuary endpoints):

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

Note: Estuary tests are integration tests (use fetch), not unit tests (use app.request).

## API Reference

Estuary endpoints:

```
POST   /v1/estuary/subscribe/:projectIdAndStreamId   Subscribe estuary to stream
DELETE /v1/estuary/subscribe/:projectIdAndStreamId   Unsubscribe estuary from stream
GET    /v1/estuary/:projectId/:estuaryId            Get estuary info
POST   /v1/estuary/:projectId/:estuaryId            Touch (refresh TTL)
DELETE /v1/estuary/:projectId/:estuaryId            Delete estuary
```

Notes:

- Subscribe/unsubscribe: estuaryId in JSON body (not URL path)
- JWT auth shown in README examples (determine if required during discovery)
- Path parsing: middleware extracts projectId/streamId from URL segments

## Coverage Analysis

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

## Reference Materials

Source code:

- `src/http/v1/estuary/*/index.ts` - Business logic to cover
- `src/http/v1/estuary/*/http.ts` - HTTP handlers
- `src/http/v1/estuary/*/schema.ts` - ArkType validation schemas

Existing test patterns:

- `test/implementation/streams/characterization.test.ts` - Integration test example
- `test/implementation/helpers.ts` - Available utilities

Coverage commands:

```bash
pnpm cov                           # Full report
pnpm run coverage:lines            # Per-file breakdown
pnpm run coverage:lines -- --zero  # 0% coverage files
```

## Execution Plan

Step 1: Assessment

```bash
cd packages/server
pnpm cov
pnpm run coverage:lines -- --zero
```

Step 2: First Test

```bash
mkdir -p test/implementation/estuary
# Create subscribe.test.ts with single test
pnpm run test -- test/implementation/estuary/subscribe.test.ts
# Read output, debug, iterate until pass
```

Step 3: Iterate

- Write next test in same file
- Run same command
- Debug based on actual errors
- Repeat until file covered

Step 4: Next Endpoint

- Create new test file (get.test.ts, touch.test.ts, etc.)
- Follow same single-test iteration
- Monitor coverage after each file

Step 5: Verification

```bash
pnpm cov                                           # Should show ~70%+
pnpm run coverage:lines -- estuary                # Verify estuary coverage
pnpm -r run typecheck && pnpm run lint && pnpm run test  # CI checks
```

## Constraints

Hard requirements:

1. Maximum 1 test function written before execution
2. Must read actual error responses (status + body + logs)
3. Integration tests use `fetch()`, never `app.request()`
4. Must verify bindings exist before assuming failure cause
5. Must check coverage after each test file completion

Previous failure mode (to avoid):

- Agent wrote 50 tests without running any
- All returned 400 errors due to unknown issue
- All tests deleted, no progress made
- Cause: Violated single-test iteration constraint

Success pattern:

```
write test → run → parse error → debug → fix → verify pass → commit → next
```

## Exit Criteria

Coverage metrics:

- Overall: ≥70% (current: 62.78%)
- Estuary endpoints: ≥70% (current: ~2%)
- Queue consumer: ≥60% (current: 0%)

Quality checks:

- All tests pass: `pnpm run test`
- Type safety: `pnpm -r run typecheck`
- Linting: `pnpm run lint`
- No new 0% coverage files introduced
