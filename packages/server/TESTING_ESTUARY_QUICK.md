# Estuary Testing - Quick Reference

## The Problem
- **Current coverage: 1.8%** (20 files, 353 uncovered lines)
- **Target: 70%+**
- Critical gap in pub/sub functionality

## Files to Create

```
test/implementation/estuary/
├── subscribe.test.ts
├── publish.test.ts
├── touch.test.ts
├── get.test.ts
└── delete.test.ts
```

## Add Helpers to `test/implementation/helpers.ts`

```typescript
estuaryUrl(path: string) {
  return `${baseUrl}/v1/estuary/${path}`;
},

async subscribe(streamId: string, subscriberUrl: string, ttlSeconds = 3600) {
  return fetch(this.estuaryUrl(`subscribe/${streamId}`), {
    method: "POST",
    headers: this.headers(),
    body: JSON.stringify({ subscriberUrl, ttlSeconds }),
  });
},

async publish(streamId: string, message: string) {
  return fetch(this.estuaryUrl(`publish/${streamId}`), {
    method: "POST",
    headers: { ...this.headers(), "Content-Type": "text/plain" },
    body: message,
  });
},

async touch(streamId: string, subscriptionId: string, ttlSeconds = 3600) {
  return fetch(this.estuaryUrl(`touch/${streamId}/${subscriptionId}`), {
    method: "POST",
    headers: this.headers(),
    body: JSON.stringify({ ttlSeconds }),
  });
},

async getSubscription(streamId: string, subscriptionId: string) {
  return fetch(this.estuaryUrl(`subscription/${streamId}/${subscriptionId}`), {
    method: "GET",
    headers: this.headers(),
  });
},

async deleteSubscription(streamId: string, subscriptionId: string) {
  return fetch(this.estuaryUrl(`subscription/${streamId}/${subscriptionId}`), {
    method: "DELETE",
    headers: this.headers(),
  });
}
```

## Test Template

```typescript
import { expect, it, describe } from "vitest";
import { createClient, uniqueStreamId } from "../helpers.ts";

describe("Estuary - [Operation]", () => {
  const client = createClient();

  it("success case", async () => {
    const streamId = uniqueStreamId("test");
    await client.createStream(streamId, "", "text/plain");
    
    const response = await client.[operation](...);
    
    expect(response.status).toBe(201); // or appropriate status
  });

  it("error case - 404", async () => {
    const response = await client.[operation]("non-existent", ...);
    expect(response.status).toBe(404);
  });

  it("error case - 401", async () => {
    const response = await fetch(url, { /* no auth */ });
    expect(response.status).toBe(401);
  });
});
```

## Test Coverage Checklist

### Subscribe (`subscribe.test.ts`)
- ✅ Create subscription
- ✅ Multiple subscriptions to same stream
- ✅ Custom TTL
- ❌ 404 for non-existent stream
- ❌ 401 without auth
- ❌ 400 for invalid TTL/URL

### Publish (`publish.test.ts`)
- ✅ Publish to stream with subscribers
- ✅ Fanout to multiple subscribers
- ✅ Appends to underlying stream
- ✅ No subscribers (still appends)
- ❌ 404 for non-existent stream
- ❌ 409 for content-type mismatch
- ❌ 401 without auth

### Touch (`touch.test.ts`)
- ✅ Extend TTL
- ✅ Updates expiry timestamp
- ❌ 404 for non-existent subscription
- ❌ 401 without auth
- ❌ 400 for invalid TTL

### Get (`get.test.ts`)
- ✅ Get subscription details
- ✅ Returns subscriptionId, streamId, subscriberUrl, expiresAt
- ❌ 404 for non-existent subscription
- ❌ 401 without auth

### Delete (`delete.test.ts`)
- ✅ Delete subscription
- ✅ Idempotent (204 even if deleted)
- ❌ 401 without auth

## Critical Notes

1. **Content-type must match**: Publish content-type must match stream's content-type
2. **Stream must exist first**: Most operations require `createStream()` in setup
3. **Use real bindings**: No mocks except for unavoidable failure scenarios
4. **Unique IDs**: Use `uniqueStreamId()` for test isolation

## Verify Coverage

```bash
# Run tests
pnpm -C packages/server test

# Check coverage
pnpm -C packages/server cov

# Estuary-specific coverage
pnpm -C packages/server run coverage:lines -- estuary
```

## Success Criteria
- All 5 test files created
- Estuary coverage: 1.8% → 70%+
- All tests pass
- No regressions in existing tests
