# Estuary Endpoint Testing Task

## 🚨 STOP: READ THIS FIRST

**Before doing ANYTHING, read: `packages/server/COVERAGE_WARNING.md`**

This is MANDATORY. Coverage files can be stale and will give you wrong information.

## ⚠️ CRITICAL: Check Fresh Coverage First

**BEFORE reading this task, you MUST run fresh coverage to see the REAL current state:**

```bash
pnpm -C packages/server cov  # Takes 60-90 seconds - MANDATORY
pnpm -C packages/server run coverage:lines -- estuary
```

**Coverage files can be STALE (hours or days old).** Never trust existing coverage reports. Always generate fresh data first.

## Goal

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

### Task 1: Add Comprehensive Fanout Tests

Create `test/implementation/estuary/publish.test.ts` with these scenarios:

**Remember: "Publishing" means POST to source stream, which triggers automatic fanout!**

- ✅ Single subscriber fanout
- ✅ Multiple subscriber fanout (3+ subscribers)
- ✅ No subscribers (should succeed, just append to source)
- ✅ Multiple sequential messages
- ✅ Different content types (application/json, text/plain)
- ✅ Late subscriber (added after initial publish)
- ✅ Message order preservation
- ❌ 404 for non-existent source stream
- ❌ 409 for content-type mismatch

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

### Task 2: Enhance Subscribe Tests

Add to `test/implementation/estuary/subscribe.test.ts`:

- ✅ Invalid estuaryId format (expect 400)
- ✅ Missing estuaryId (expect 400)
- ✅ Same estuary subscribing to multiple source streams
- ✅ Content-type mismatch when subscribing to second stream (expect 500)
- ✅ Improved idempotency testing

### Task 3: Verify Existing Tests

These files already exist with good coverage - verify they pass:

- `test/implementation/estuary/get.test.ts` (100% coverage)
- `test/implementation/estuary/delete.test.ts` (100% coverage)
- `test/implementation/estuary/unsubscribe.test.ts` (92.8% coverage)
- `test/implementation/estuary/fanout.test.ts` (basic fanout test)

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
3. **estuaryId is a UUID**: Use `crypto.randomUUID()`, not a prefixed stream ID
4. **Fanout is async**: Use polling helper to wait for messages to arrive in estuaries
5. **No auth in tests**: All test streams use `?public=true` for simplicity
6. **Real bindings only**: Tests run against live wrangler workers - no mocks
7. **Unique IDs**: Use `uniqueStreamId()` for source streams, `crypto.randomUUID()` for estuaries

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

## Success Criteria

- ✅ New `publish.test.ts` created (10+ comprehensive fanout tests)
- ✅ Existing `subscribe.test.ts` enhanced (5+ additional test cases)
- ✅ All tests pass (27+ test files, 91+ tests)
- ✅ Estuary coverage: 70.3% → 75%+
- ✅ Overall coverage: 73% → 75%+
- ✅ Subscribe coverage: 83%+
- ✅ Fanout coverage: 80%+
- ✅ No new 0% files introduced
- ✅ Typecheck passes
- ✅ Lint passes (0 errors, 0 warnings)
- ✅ Format check passes
- ✅ Unit tests pass (341+ tests)
- ✅ Conformance tests pass (239 tests)

## Expected Coverage After Changes

Based on previous successful run:

- **Overall**: 73.06% → 75%+ (target)
- **Estuary average**: 70.5% → 75%+
- **Subscribe**: 83.3%
- **Unsubscribe**: 92.8%
- **Get**: 100%
- **Delete**: 100%
- **Fanout**: 76.5% → 80%+

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

## Known Issues & Solutions

### Issue: Validation returns 400 instead of 500

**Expected**: Validation errors (invalid estuaryId format, missing fields) return **400 Bad Request**, not 500

**Correct Test**: `expect(response.status).toBe(400);`

### Issue: `publish/index.ts` shows 0% coverage

**Expected**: This file contains unused dead code (`publishToStream()` function is never called)

**Solution**: File can be safely deleted - the actual fanout logic is in `fanout.ts` and called via `fanoutOnly()` RPC method
