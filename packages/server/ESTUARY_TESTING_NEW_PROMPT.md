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

- **Subscribe**: Create a subscription to receive messages from a stream
- **Publish**: Fan out messages to all subscribers
- **Get**: Retrieve subscription details
- **Delete**: Remove a subscription
- **Unsubscribe**: Alias for delete

## Files Needing Tests (Currently 0% Coverage)

### Publish (96 lines)

- `src/http/v1/estuary/publish/index.ts` (62 lines)
- `src/http/v1/estuary/publish/fanout.ts` (34 lines)

### Subscribe (49 lines)

- `src/http/v1/estuary/subscribe/index.ts` (42 lines)
- `src/http/v1/estuary/subscribe/http.ts` (7 lines)

### Get (19 lines)

- `src/http/v1/estuary/get/index.ts` (15 lines)
- `src/http/v1/estuary/get/http.ts` (4 lines)

### Delete (15 lines)

- `src/http/v1/estuary/delete/index.ts` (11 lines)
- `src/http/v1/estuary/delete/http.ts` (4 lines)

### Unsubscribe (21 lines)

- `src/http/v1/estuary/unsubscribe/index.ts` (14 lines)
- `src/http/v1/estuary/unsubscribe/http.ts` (7 lines)

## Your Tasks

### Task 1: Add Helper Functions

Add these to `test/implementation/helpers.ts`:

```typescript
estuaryUrl(path: string) {
  return `${this.baseUrl}/v1/estuary/${path}`;
}

async subscribe(streamId: string, subscriberUrl: string, ttlSeconds = 3600) {
  return fetch(this.estuaryUrl(`subscribe/${streamId}`), {
    method: "POST",
    headers: this.headers(),
    body: JSON.stringify({ subscriberUrl, ttlSeconds }),
  });
}

async publish(streamId: string, message: string, contentType = "text/plain") {
  return fetch(this.estuaryUrl(`publish/${streamId}`), {
    method: "POST",
    headers: { ...this.headers(), "Content-Type": contentType },
    body: message,
  });
}

async getSubscription(streamId: string, subscriptionId: string) {
  return fetch(this.estuaryUrl(`subscription/${streamId}/${subscriptionId}`), {
    method: "GET",
    headers: this.headers(),
  });
}

async deleteSubscription(streamId: string, subscriptionId: string) {
  return fetch(this.estuaryUrl(`subscription/${streamId}/${subscriptionId}`), {
    method: "DELETE",
    headers: this.headers(),
  });
}
```

### Task 2: Create Test Files

Create these files in `test/implementation/estuary/`:

#### `publish.test.ts`

Test scenarios:

- ✅ Publish to stream with one subscriber
- ✅ Publish to stream with multiple subscribers
- ✅ Publish appends to underlying stream
- ✅ Publish with no subscribers (still appends)
- ❌ 404 for non-existent stream
- ❌ 401 without auth
- ❌ 409 for content-type mismatch

#### `get.test.ts`

Test scenarios:

- ✅ Get subscription details
- ✅ Response includes all fields (subscriptionId, streamId, subscriberUrl, expiresAt)
- ❌ 404 for non-existent subscription
- ❌ 401 without auth

#### `delete.test.ts`

Test scenarios:

- ✅ Delete subscription
- ✅ Idempotent (204 even if already deleted)
- ❌ 401 without auth

#### `unsubscribe.test.ts`

Test scenarios:

- ✅ Unsubscribe removes subscription
- ✅ Idempotent
- ❌ 401 without auth

### Task 3: Update Existing Tests

Update `test/implementation/estuary/subscribe.test.ts` to add:

- Multiple subscriptions to same stream
- Custom TTL values
- Invalid TTL (400)
- Invalid subscriberUrl (400)
- Missing body (400)

## Test Pattern

Use this pattern for all tests:

```typescript
import { expect, it, describe } from "vitest";
import { createClient, uniqueStreamId } from "../helpers.ts";

describe("Estuary - [Operation]", () => {
  const client = createClient();

  it("success case", async () => {
    const streamId = uniqueStreamId("test");

    // Create stream first
    await client.createStream(streamId, "", "text/plain");

    // Test the operation
    const response = await client.[operation](...);

    expect(response.status).toBe(201);
    const data = await response.json();
    // Assert on response data
  });

  it("error case - 404", async () => {
    const response = await client.[operation]("non-existent", ...);
    expect(response.status).toBe(404);
  });

  it("error case - 401", async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // No auth
      body: "..."
    });
    expect(response.status).toBe(401);
  });
});
```

## Critical Notes

1. **Content-type must match**: Stream and publish content-type must match
2. **Stream must exist first**: Use `client.createStream()` before testing estuary operations
3. **Real bindings only**: Use `@cloudflare/vitest-pool-workers` - no mocks
4. **Unique IDs**: Use `uniqueStreamId()` for each test

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

- ✅ All 4 new test files created (`publish.test.ts`, `get.test.ts`, `delete.test.ts`, `unsubscribe.test.ts`)
- ✅ Existing `subscribe.test.ts` updated with more scenarios
- ✅ All tests pass
- ✅ Estuary coverage: 1.8% → 70%+
- ✅ Overall coverage: 63% → 75%+
- ✅ No estuary files in zero coverage list
- ✅ Typecheck passes
- ✅ Lint passes
- ✅ Format check passes

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

**DO NOT skip the coverage verification step.** You MUST run fresh coverage and confirm the numbers improved. Simply writing tests is not enough - you must verify they actually cover the code WITH FRESH DATA.
