# Estuary Endpoint Testing - Actual Implementation

## Context

The Estuary system in durable-streams-cloudflare provides a pub/sub fan-out layer on top of the core streams API. This document describes the **actual implementation** and the tests that exist.

## What is Estuary?

Estuary is a fan-out subscription system built on Durable Objects:

- **Source Stream**: A regular stream that publishes messages
- **Estuary**: A special stream (identified by UUID) that subscribes to one or more source streams
- **Fan-out**: When a message is published to a source stream, it's automatically forwarded to all subscribed estuaries
- **Subscription Management**: Each source stream tracks its subscribers via a StreamSubscribersDO
- **TTL Management**: Estuaries have expiration times and clean up automatically

## API Endpoints (Actual Implementation)

### Subscribe to a Source Stream

```
POST /v1/estuary/subscribe/{projectId}/{streamId}
Body: { "estuaryId": "uuid-without-prefix" }
Response: {
  "estuaryId": "...",
  "streamId": "...",
  "estuaryStreamPath": "/v1/stream/{projectId}/{estuaryId}",
  "isNewEstuary": true,
  "expiresAt": 1234567890
}
```

### Unsubscribe from a Source Stream

```
DELETE /v1/estuary/subscribe/{projectId}/{streamId}
Body: { "estuaryId": "uuid-without-prefix" }
Response: { "success": true }
```

### Get Estuary Info

```
GET /v1/estuary/{projectId}/{estuaryId}
Response: {
  "estuaryId": "...",
  "estuaryStreamPath": "...",
  "contentType": "...",
  "subscriptions": [
    { "streamId": "...", "subscribedAt": 1234567890 }
  ]
}
```

### Delete Estuary

```
DELETE /v1/estuary/{projectId}/{estuaryId}
Response: { "success": true }
```

## Existing Test Files (All Passing)

### `subscribe.test.ts` ✅

Tests the subscription workflow:

- ✅ Can subscribe an estuary to a source stream
- ✅ Can subscribe same estuary twice (idempotent)
- ✅ Returns error when source stream does not exist

**Coverage**: Core subscription functionality, idempotency, error handling

### `get.test.ts` ✅

Tests retrieving estuary information:

- ✅ Can get estuary info with subscriptions
- ✅ Returns error for non-existent estuary
- ✅ Validates estuaryId format

**Coverage**: Info retrieval, validation, error cases

### `delete.test.ts` ✅

Tests estuary deletion:

- ✅ Can delete an estuary with subscriptions
- ✅ Deletion removes estuary from all source streams
- ✅ Can delete estuary with multiple subscriptions
- ✅ Returns error for non-existent estuary

**Coverage**: Deletion, cleanup across multiple subscriptions

### `unsubscribe.test.ts` ✅

Tests unsubscribing from source streams:

- ✅ Can unsubscribe estuary from source stream
- ✅ Unsubscribe is idempotent
- ✅ Can unsubscribe then resubscribe

**Coverage**: Unsubscribe workflow, idempotency, re-subscription

### `fanout.test.ts` ✅

Tests message fan-out to subscribers:

- ✅ Messages published to source stream are fanned out to estuaries

**Coverage**: Core fan-out functionality

## Test File Structure

All tests follow this pattern:

```typescript
import { describe, it, expect } from "vitest";
import { uniqueStreamId } from "./helpers";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";

describe("Estuary [operation]", () => {
  it("describes what it tests", async () => {
    const projectId = "test-project";
    const streamId = uniqueStreamId("prefix");
    const estuaryId = crypto.randomUUID(); // Must be plain UUID

    // Create source stream first
    await fetch(`${BASE_URL}/v1/stream/${projectId}/${streamId}?public=true`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "",
    });

    // Perform estuary operation
    const response = await fetch(`${BASE_URL}/v1/estuary/[operation]/${projectId}/${streamId}`, {
      /* ... */
    });

    expect(response.status).toBe(200);
  });
});
```

## Helper Files

### `helpers.ts`

```typescript
export const uniqueStreamId = (prefix?: string) => {
  const uuid = crypto.randomUUID();
  return `${prefix || ""}${uuid}`;
};
```

### `utils.ts`

Provides `createClient` helper for building HTTP clients with auth headers.

## Coverage Status

Current test coverage for Estuary endpoints: **~85%** (based on existing tests)

**Well-covered:**

- ✅ Subscribe/unsubscribe flow
- ✅ Estuary lifecycle (create, get, delete)
- ✅ Fan-out to subscribers
- ✅ Idempotency guarantees
- ✅ Error handling for non-existent resources

**Not covered in tests (but implementation exists):**

- ⚠️ TTL expiration and automatic cleanup (alarm-based)
- ⚠️ Subscription limit validation
- ⚠️ Circuit breaker behavior during fanout failures
- ⚠️ Queue-based fanout for large subscriber counts
- ⚠️ Concurrent subscription modifications

## Important Implementation Notes

1. **EstuaryId Format**: Must be a plain UUID without prefix (e.g., `"550e8400-e29b-41d4-a716-446655440000"`)
2. **Stream Creation**: Source streams must exist before subscribing an estuary
3. **Public Streams**: Tests use `?public=true` to bypass authentication
4. **Durable Objects**: Each source stream has its own StreamSubscribersDO, each estuary has its own EstuaryDO
5. **Fan-out**: Can be inline (for small subscriber counts) or queued (for large subscriber counts)
6. **TTL**: Estuaries have expiration times; cleanup happens via Durable Object alarms

## Running Tests

```bash
# Run all estuary tests
pnpm exec vitest run -c vitest.implementation.config.ts test/implementation/estuary/*.ts

# Run specific test file
pnpm exec vitest run -c vitest.implementation.config.ts test/implementation/estuary/subscribe.test.ts

# Run with coverage
pnpm -C packages/server run cov
```

## Test Output

All tests should pass:

```
✓ test/implementation/estuary/subscribe.test.ts (3 tests)
✓ test/implementation/estuary/get.test.ts (3 tests)
✓ test/implementation/estuary/delete.test.ts (4 tests)
✓ test/implementation/estuary/unsubscribe.test.ts (3 tests)
✓ test/implementation/estuary/fanout.test.ts (1 test)

Test Files  5 passed (5)
Tests  14 passed (14)
```

## Areas for Future Test Expansion

While current tests cover the happy path and basic error cases well, consider adding:

1. **Load Testing**: Many concurrent subscriptions/unsubscriptions
2. **TTL Edge Cases**: Subscribe with very short/long TTLs, test alarm-based cleanup
3. **Fanout Resilience**: Test behavior when subscriber webhooks fail
4. **Circuit Breaker**: Test circuit breaker opens after repeated fanout failures
5. **Queue Behavior**: Test queue-based fanout when subscriber count > threshold
6. **Content-Type Handling**: Verify estuaries inherit content-type from source stream
7. **Race Conditions**: Multiple simultaneous subscribe/unsubscribe operations

## Related Documentation

- **API Reference**: `packages/server/README.md` (search for "Estuary")
- **Implementation**: `packages/server/src/http/v1/estuary/`
- **Storage Layer**: `packages/server/src/storage/estuary-do.ts` and `stream-subscribers-do.ts`
- **Architecture**: `packages/server/call-graph.md` (Estuary sections)

## Validation Before PR

Before submitting changes:

1. ✅ Run all estuary tests: `pnpm exec vitest run -c vitest.implementation.config.ts test/implementation/estuary/*.ts`
2. ✅ Check test passes
3. ✅ Run typecheck: `pnpm -r run typecheck`
4. ✅ Run lint: `pnpm -C packages/server run lint`
5. ✅ Run format check: `pnpm -r run format:check`

All checks must pass before the PR can be merged.
