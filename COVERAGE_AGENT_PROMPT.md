# Coverage Improvement Agent Prompt

Copy this entire document and paste it into a new LLM session to work on test coverage.

---

## Your Task

Improve test coverage for the Durable Streams Cloudflare server package. Current coverage is **62.78%**, goal is **70%+**.

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

### For Estuary Endpoints (Priority 1)

Create integration tests in `test/implementation/estuary/`:

```typescript
// test/implementation/estuary/subscribe.test.ts
import { describe, it, expect } from "vitest";
import { createClient, uniqueStreamId } from "../helpers";

describe("Estuary subscribe", () => {
  it("subscribes session to estuary", async () => {
    const baseUrl = process.env.IMPLEMENTATION_TEST_URL;
    const estuaryId = uniqueStreamId("estuary");

    // Create estuary first
    const createRes = await fetch(`${baseUrl}/v1/estuary/${estuaryId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamId: "test-stream",
        contentType: "application/json",
      }),
    });
    expect(createRes.status).toBe(201);

    // Subscribe
    const subscribeRes = await fetch(`${baseUrl}/v1/estuary/${estuaryId}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1" }),
    });
    expect(subscribeRes.status).toBe(200);
  });
});
```

**Note**: Use `createClient()` and `uniqueStreamId()` from `../helpers` - see existing tests in `test/implementation/streams/` for patterns.

**Files to create:**

- `test/implementation/estuary/subscribe.test.ts` - subscribe/unsubscribe
- `test/implementation/estuary/publish.test.ts` - publish/fanout
- `test/implementation/estuary/touch.test.ts` - keepalive
- `test/implementation/estuary/get.test.ts` - get info
- `test/implementation/estuary/delete.test.ts` - delete estuary

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
PUT    /v1/estuary/:id                    Create estuary
GET    /v1/estuary/:id                    Get estuary info
DELETE /v1/estuary/:id                    Delete estuary
POST   /v1/estuary/:id/subscribe          Subscribe session
POST   /v1/estuary/:id/unsubscribe        Unsubscribe session
POST   /v1/estuary/:id/publish            Publish to all subscribers
POST   /v1/estuary/:id/touch              Keep session alive
```

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

1. Run `pnpm cov` to see current status
2. Run `pnpm run coverage:lines -- --zero` to see priority files
3. Pick the estuary endpoint with the most uncovered lines
4. Read the source file to understand what it does
5. Create a test file in `test/implementation/estuary/`
6. Write tests covering the main code paths
7. Run `pnpm run test:implementation` to verify tests pass
8. Run `pnpm cov` to see coverage improvement
9. Repeat for next file

**Focus on files with 0% coverage first - biggest impact!**

## Expected Time

- Estuary tests: ~2-4 hours (20 files)
- Queue consumer test: ~30 minutes (1 file)
- Edge cases: ~1-2 hours

Total: ~4-7 hours to reach 70% coverage

---

**You have all the context you need. Start with `pnpm cov` and tackle the 0% files first!**
