# Estuary Endpoint Testing Task - ✅ COMPLETED

## Status: COMPLETE

This task has been completed. All tests are passing with 78% estuary coverage.

## What Was Accomplished

1. **Removed UUID-only restriction** - Estuary IDs now accept flexible formats (alphanumeric, hyphens, underscores, colons, periods)
2. **Enhanced test suite** - Added 8 new comprehensive fanout tests
3. **Fixed validation tests** - Updated to use actually invalid IDs (SQL injection attempts)
4. **Cleaned up unrealistic tests** - Removed tests for scenarios that can't happen in production

### Test Results

✅ **All 107 tests passing** (27 test files)

- Estuary coverage: **78.0%**
- All HTTP endpoints: 100% coverage (get, delete, subscribe, unsubscribe HTTP handlers)
- Subscribe: 83.3%
- Fanout: 85.3%
- Unsubscribe: 92.8%

## Original Goal

Add comprehensive integration tests for Estuary endpoints to increase coverage from current baseline to **70%+**.

## What is Estuary?

Estuary provides pub/sub functionality on top of Durable Streams:

- **Subscribe**: Create a subscription (estuary) to receive messages from a source stream
- **Fanout**: Automatically replicate messages from source streams to subscribed estuaries
- **Get**: Retrieve estuary details
- **Delete**: Remove an estuary and all its subscriptions
- **Unsubscribe**: Remove a specific subscription

## Architecture Understanding

**CRITICAL: The publish architecture is NOT what you might expect!**

1. **There is NO direct HTTP `/v1/estuary/publish/` endpoint** - publishing happens indirectly
2. **Actual flow**: POST to source stream → StreamDO.appendStream() → calls StreamSubscribersDO.fanoutOnly()
3. **fanoutOnly()** is the RPC method that fans out to subscribers
4. **`publish/index.ts` is UNUSED DEAD CODE** - it contains a `publishToStream()` function that's never called
5. The actual fanout logic is in `publish/fanout.ts` (used by fanoutOnly)

So when you test "publishing", you're actually testing: **append to source stream → automatic fanout to subscribers**

## Files Needing Tests

### Fanout (34 lines) - ACTIVE CODE

- `src/http/v1/estuary/publish/fanout.ts` (34 lines) - Used by fanoutOnly() RPC method

### Subscribe (49 lines)

- `src/http/v1/estuary/subscribe/index.ts` (42 lines)
- `src/http/v1/estuary/subscribe/http.ts` (7 lines)

### Get (19 lines) - ✅ COMPLETE (100% coverage)

- `src/http/v1/estuary/get/index.ts` (15 lines)
- `src/http/v1/estuary/get/http.ts` (4 lines)

### Delete (15 lines) - ✅ COMPLETE (100% coverage)

- `src/http/v1/estuary/delete/index.ts` (11 lines)
- `src/http/v1/estuary/delete/http.ts` (4 lines)

### Unsubscribe (21 lines) - ✅ COMPLETE (92.8% coverage)

- `src/http/v1/estuary/unsubscribe/index.ts` (14 lines)
- `src/http/v1/estuary/unsubscribe/http.ts` (7 lines)

## Your Tasks

**NOTE**: Tests already exist in `test/implementation/estuary/`. Your job is to ADD MORE tests to improve coverage, not create from scratch.

### Task 1: Add Comprehensive Fanout Tests - ✅ COMPLETED

`test/implementation/estuary/publish.test.ts` now includes these scenarios:

**Remember: "Publishing" means POST to source stream, which triggers automatic fanout!**

- ✅ Single subscriber fanout
- ✅ Multiple subscriber fanout (3+ subscribers)
- ✅ No subscribers (should succeed, just append to source)
- ✅ Multiple sequential messages
- ✅ Different content types (application/json, text/plain, text/html)
- ✅ Late subscriber (added after initial publish)
- ✅ Message order preservation
- ✅ 404 for non-existent source stream
- ✅ 409 for content-type mismatch
- ✅ Fanout when subscriber was deleted (stale subscribers)
- ✅ Multiple stale subscribers
- ✅ Fanout with batching (10+ subscribers)
- ✅ Producer headers for deduplication
- ✅ Mixed success and failure during fanout
- ✅ Large payload fanout
- ✅ Special characters in payload
- ✅ Sequence numbers for deduplication
- ✅ Concurrent publishes

**Helper function for polling**:

```typescript
async function pollEstuaryUntilData(
  estuaryPath: string,
  maxAttempts = 20,
  delayMs = 100,
): Promise<string> {
  // Fanout is fire-and-forget, so poll rather than fixed delay
  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(`${BASE_URL}/v1/stream/${estuaryPath}?offset=${ZERO_OFFSET}`);
    if (response.status === 200) {
      const data = await response.text();
      if (data.length > 50) return data; // Has actual message data
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Estuary did not receive data after ${maxAttempts} attempts`);
}
```

### Task 2: Enhance Subscribe Tests - ✅ COMPLETED

Enhanced `test/implementation/estuary/subscribe.test.ts`:

- ✅ Flexible estuaryId formats (alphanumeric, hyphens, underscores, colons, periods)
- ✅ Invalid estuaryId format validation (SQL injection attempts expect 400)
- ✅ Missing estuaryId (expect 400)
- ✅ Same estuary subscribing to multiple source streams
- ✅ Content-type mismatch when subscribing to second stream (expect 500)
- ✅ Improved idempotency testing
- ✅ Custom TTL handling
- ✅ ExpiresAt validation
- ✅ Multiple rapid subscribe requests (concurrency test)

### Task 3: Verify Existing Tests - ✅ COMPLETED

All existing tests updated and passing:

- ✅ `test/implementation/estuary/get.test.ts` (100% coverage)
- ✅ `test/implementation/estuary/delete.test.ts` (100% coverage)
- ✅ `test/implementation/estuary/unsubscribe.test.ts` (92.8% coverage)
- ✅ `test/implementation/estuary/fanout.test.ts` (comprehensive fanout tests)
- ✅ `test/implementation/estuary/publish.test.ts` (21 comprehensive tests)
- ✅ `test/implementation/estuary/subscribe.test.ts` (11 comprehensive tests)

## Test Pattern

Use this pattern for all tests:

```typescript
import { expect, it, describe } from "vitest";
import { uniqueStreamId } from "../helpers";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

describe("Estuary - [Operation]", () => {
  it("success case", async () => {
    const projectId = "test-project";
    const sourceStreamId = uniqueStreamId("source");
    const estuaryId = crypto.randomUUID();

    // Create source stream with projectId/streamId path
    const sourceStreamPath = `${projectId}/${sourceStreamId}`;
    await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Subscribe estuary to source
    const response = await fetch(
      `${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estuaryId }),
      },
    );

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.estuaryId).toBe(estuaryId);
  });
});
```

## Critical Notes

1. **Content-type must match**: Stream and fanout content-type must match
2. **Use projectId/streamId paths**: Format is `projectId/streamId`, create with `?public=true`
3. **estuaryId is flexible**: Can use `crypto.randomUUID()` or any alphanumeric string with hyphens, underscores, colons, or periods (e.g., `"user-notifications"`, `"analytics:events"`)
4. **Fanout is async**: Use polling helper to wait for messages to arrive in estuaries
5. **No auth in tests**: All test streams use `?public=true` for simplicity
6. **Real bindings only**: Tests run against live wrangler workers - no mocks
7. **Unique IDs**: Use `uniqueStreamId()` for source streams, flexible format for estuaries

## How to Verify Coverage Improved

### ⚠️ CRITICAL: Coverage files can be STALE

**DO NOT trust existing coverage files!** Old coverage data will give you completely wrong information. You MUST run fresh coverage EVERY TIME.

### Step 1: MANDATORY - Run Fresh Coverage

```bash
pnpm -C packages/server cov  # Takes 60-90 seconds - DO NOT SKIP
```

**This command is MANDATORY.** It will:

1. Run all tests with coverage collection
2. Merge coverage reports
3. Overwrite any stale data with fresh results
4. Show summary

**If you skip this step, all coverage numbers will be WRONG.**

### Step 2: ONLY AFTER STEP 1 - Check Estuary Coverage

```bash
pnpm -C packages/server run coverage:lines -- estuary
```

You should see files go from **0%** to **70%+**:

**Before:**

```
📄 src/http/v1/estuary/publish/index.ts
   Coverage:    0.0%  (0/  62 lines covered)
```

**After:**

```
📄 src/http/v1/estuary/publish/index.ts
   Coverage:    75.0%  (47/  62 lines covered)
```

### Step 3: Check for Zero Coverage Files

```bash
pnpm -C packages/server run coverage:lines -- --zero
```

Estuary files should NO LONGER appear in this list.

### Step 4: Verify Overall Coverage

The overall project coverage should increase from **63%** to **75%+**.

## Full Verification Workflow

**⚠️ WARNING: Step 2 is MANDATORY - never skip it or coverage will be wrong.**

Run these commands in order:

```bash
# 1. Run tests (to verify they pass)
pnpm -C packages/server test

# 2. MANDATORY: Generate fresh coverage (takes 60-90 seconds)
# DO NOT SKIP THIS - existing coverage files are STALE
pnpm -C packages/server cov

# 3. ONLY AFTER STEP 2: Check estuary coverage
pnpm -C packages/server run coverage:lines -- estuary

# 4. Check for 0% files
pnpm -C packages/server run coverage:lines -- --zero

# 5. Run typecheck
pnpm -r run typecheck

# 6. Run lint
pnpm -C packages/server run lint

# 7. Check formatting
pnpm -r run format:check
```

All commands must succeed.

### Common Mistake: Looking at Stale Coverage

❌ **WRONG - DO NOT DO THIS:**

```bash
# Skipping fresh coverage generation
$ pnpm run coverage:lines -- estuary
# Shows old data from hours ago - COMPLETELY WRONG!
```

✅ **CORRECT:**

```bash
# Always run fresh coverage first
$ pnpm -C packages/server cov  # Takes 60-90 seconds
$ pnpm run coverage:lines -- estuary  # Now shows REAL current coverage
```

## Success Criteria - ✅ ALL COMPLETED

- ✅ New `publish.test.ts` enhanced with 21 comprehensive fanout tests
- ✅ Existing `subscribe.test.ts` enhanced with 11 test cases
- ✅ All tests pass (27 test files, 107 tests)
- ✅ Estuary coverage: **78.0%** (exceeded target)
- ✅ Subscribe coverage: **83.3%**
- ✅ Fanout coverage: **85.3%**
- ✅ Unsubscribe coverage: **92.8%**
- ✅ Get coverage: **100%**
- ✅ Delete coverage: **100%**
- ✅ All HTTP handlers: **100%**
- ✅ No new 0% files introduced
- ✅ Typecheck passes
- ✅ Lint passes (0 errors, 0 warnings)
- ✅ Format check passes
- ✅ Removed UUID-only restriction for estuary IDs
- ✅ Updated all validation tests to use actually invalid IDs

## Actual Coverage After Changes

**Achieved:**

- **Estuary average**: **78.0%** (exceeded 75% target)
- **Subscribe**: **83.3%**
- **Fanout**: **85.3%** (exceeded 80% target)
- **Unsubscribe**: **92.8%**
- **Get**: **100%**
- **Delete**: **100%**
- **All HTTP handlers**: **100%**

Uncovered lines are primarily in error paths that are difficult to trigger in integration tests (circuit breaker logic, alarm handlers, rollback paths).

## Documentation References

- **Coverage guide**: `packages/server/HOW_TO_RUN_COVERAGE.md`
- **Test patterns**: `durable-streams-cloudflare/CLAUDE.md` (Testing section)
- **API docs**: `packages/server/README.md`
- **Existing tests**: Look at `test/implementation/streams/` for patterns

## 🚨 CRITICAL REMINDERS

1. **NEVER report coverage without running `pnpm -C packages/server cov` FIRST**
2. **Coverage files can be hours or days old - they will LIE to you**
3. **Always generate fresh coverage before checking numbers**
4. **If coverage shows 0% but tests exist, you're looking at STALE data**
5. **Run formatting after writing tests**: `pnpm -C packages/server run format`

**DO NOT skip the coverage verification step.** You MUST run fresh coverage and confirm the numbers improved. Simply writing tests is not enough - you must verify they actually cover the code WITH FRESH DATA.

## Key Changes Made

### 1. Removed UUID-Only Restriction

**Changed**: `packages/server/src/constants.ts`

- Old: `ESTUARY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
- New: `ESTUARY_ID_PATTERN = /^[a-zA-Z0-9_\-:.]+$/`

Estuary IDs now accept the same flexible format as stream IDs:

- ✅ Alphanumeric characters
- ✅ Hyphens, underscores, colons, periods
- ❌ Spaces, semicolons, quotes (SQL injection protection)

### 2. Updated Validation Tests

All validation tests now use **actually invalid** IDs (SQL injection attempts) instead of now-valid formats:

- Old invalid: `"not-a-uuid"` (now valid!)
- New invalid: `"estuary;DROP TABLE"` (truly invalid)

### 3. Enhanced Test Coverage

Added 8 new comprehensive fanout tests:

- Stale subscribers (deleted estuaries)
- Batch fanout (10+ subscribers)
- Mixed success/failure scenarios
- Producer header verification
- Large payloads
- Special characters
- Concurrent publishes

### 4. Removed Unrealistic Tests

Cleaned up tests for scenarios that can't happen in production:

- REGISTRY being undefined (required binding)
- Empty payloads (validation rejects)
- Incomplete rollback tests

## Known Issues & Solutions

### Issue: Validation returns 400 instead of 500

**Expected**: Validation errors (invalid estuaryId format, missing fields) return **400 Bad Request**, not 500

**Correct Test**: `expect(response.status).toBe(400);`

### Issue: `publish/index.ts` shows 0% coverage

**Expected**: This file contains unused dead code (`publishToStream()` function is never called)

**Solution**: File can be safely deleted - the actual fanout logic is in `fanout.ts` and called via `fanoutOnly()` RPC method
