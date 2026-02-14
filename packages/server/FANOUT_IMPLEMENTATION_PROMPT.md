# Critical: Implement Missing Fanout Functionality

## Problem Statement

The estuary pub/sub fanout feature is **NOT HOOKED UP** in the current implementation. Tests exist but fail because:

1. When a client POSTs to a source stream (e.g., `/v1/stream/project/notifications`), the StreamDO.appendStream() method writes the data to SQLite
2. **BUT** it never calls StreamSubscribersDO.publish() to fan out the message to subscribers
3. Result: Messages written to source streams never reach estuary subscribers

## Evidence

- `src/http/v1/streams/append/index.ts` - appendStream() has NO fanout logic
- `src/http/v1/estuary/stream-subscribers-do.ts` - publish() method exists but is never called
- `src/http/v1/estuary/publish/index.ts` - publishToStream() function exists but has 0% coverage
- Integration test pattern exists in `test/implementation/estuary/subscribe.test.ts` (passing)
- Fanout integration test would fail because fanout never triggers

## Architecture (from call-graph.md)

**Current flow (INCOMPLETE):**
```
Client POST /v1/stream/project/source
  ↓
Edge Worker routes to StreamDO
  ↓
StreamDO.appendStream() writes to SQLite
  ↓
MISSING: Call to StreamSubscribersDO.publish()
  ↓
MISSING: Fanout to estuary streams
```

**Required flow:**
```
Client POST /v1/stream/project/source
  ↓
Edge Worker routes to StreamDO
  ↓
StreamDO.appendStream() writes to SQLite
  ↓
StreamDO checks if SUBSCRIPTION_DO exists for this stream
  ↓
If subscribers exist: Call StreamSubscribersDO.publish(projectId, streamId, payload)
  ↓
StreamSubscribersDO.publish() → publishToStream() → fanoutToSubscribers()
  ↓
For each subscriber: Write to estuary stream (inline or via queue)
```

## Implementation Requirements

### 1. Hook Fanout into StreamDO Append

**File:** `src/http/v1/streams/append/index.ts`

After successful append (step 4 in executeAppend, after broadcast), add:

```typescript
// 5. Fan out to subscribers if this stream has any
if (ctx.env.SUBSCRIPTION_DO) {
  try {
    const sourceDoKey = `${projectId}/${streamId}`;
    const subStub = ctx.env.SUBSCRIPTION_DO.get(
      ctx.env.SUBSCRIPTION_DO.idFromName(sourceDoKey)
    ) as DurableObjectStub<StreamSubscribersDO>;
    
    // Call publish in background (don't await - fire and forget)
    ctx.waitUntil(
      subStub.publish(projectId, streamId, {
        payload: payload.slice(0), // Clone ArrayBuffer
        contentType: meta.content_type,
      })
    );
  } catch (err) {
    // Log but don't fail the write if fanout fails
    logWarn({ streamId, component: 'fanout-trigger' }, 'Failed to trigger fanout', err);
  }
}
```

**Key points:**
- Use `ctx.waitUntil()` to avoid blocking the write response
- Clone the payload ArrayBuffer (transferred across RPC boundaries)
- Don't await - fanout failures shouldn't block writes
- Need projectId - extract from streamId or pass through context

### 2. Add ProjectId to StreamContext

**Problem:** StreamContext doesn't have projectId, but fanout needs it.

**Solution:** Extract projectId from streamId (format: "project/stream")

```typescript
const parts = streamId.split('/');
const projectId = parts[0];
const streamName = parts.slice(1).join('/');
```

Or add projectId to StreamContext if available from edge worker.

### 3. Verify PublishToStream Implementation

**File:** `src/http/v1/estuary/publish/index.ts`

Current implementation looks complete (lines 11-170):
- Writes to source stream ✓
- Gets subscribers from StreamSubscribersDoStorage ✓
- Calls fanoutToSubscribers() ✓
- Handles circuit breaker ✓
- Records metrics ✓

**Verify this actually works once hooked up.**

### 4. Integration Test Pattern

**File:** `test/implementation/estuary/fanout.test.ts`

```typescript
it("publishes to source and fans out to subscriber", async () => {
  const projectId = "test-project";
  const sourceStreamId = uniqueStreamId("source");
  const estuaryId = crypto.randomUUID();

  // 1. Create source stream
  const sourceStreamPath = `${projectId}/${sourceStreamId}`;
  await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}?public=true`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
  });

  // 2. Subscribe estuary to source
  await fetch(`${BASE_URL}/v1/estuary/subscribe/${projectId}/${sourceStreamId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ estuaryId }),
  });

  // 3. Publish to source (should fanout)
  const message = { type: "test", content: "Hello" };
  await fetch(`${BASE_URL}/v1/stream/${sourceStreamPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([message]),
  });

  // 4. Verify message in estuary stream
  const estuaryPath = `${projectId}/${estuaryId}`;
  const response = await fetch(`${BASE_URL}/v1/stream/${estuaryPath}?offset=0000000000000000`);
  const data = await response.text();
  
  expect(data).toContain("Hello");
});
```

## Files to Modify

1. **`src/http/v1/streams/append/index.ts`** - Add fanout trigger after append
2. **`src/http/v1/streams/types.ts`** - Add SUBSCRIPTION_DO to StreamContext env (if missing)
3. **`test/implementation/estuary/fanout.test.ts`** - Create integration test

## Files to Review

1. **`src/http/v1/estuary/publish/index.ts`** - Verify publishToStream() logic
2. **`src/http/v1/estuary/publish/fanout.ts`** - Verify fanoutToSubscribers() logic
3. **`src/http/v1/estuary/stream-subscribers-do.ts`** - Verify publish() RPC method

## Testing Protocol

1. Implement the hook in append/index.ts
2. Run: `pnpm run test -- test/implementation/estuary/subscribe.test.ts`
3. Create fanout.test.ts with single test
4. Run: `pnpm run test -- test/implementation/estuary/fanout.test.ts`
5. Debug based on actual errors
6. Verify coverage: `pnpm run coverage:lines -- estuary`

## Expected Coverage Impact

Current estuary coverage: ~2% (308 uncovered lines)
After fanout hookup: ~40-60% (publish/fanout paths exercised)

Files that will gain coverage:
- `src/http/v1/estuary/publish/index.ts` (62 lines)
- `src/http/v1/estuary/publish/fanout.ts` (34 lines)
- `src/http/v1/estuary/stream-subscribers-do.ts` (42 lines)

Total: ~138 lines of critical fanout logic

## Success Criteria

- [ ] POST to source stream triggers StreamSubscribersDO.publish()
- [ ] Messages appear in all subscribed estuary streams
- [ ] Fanout failures don't block source stream writes
- [ ] Integration test passes
- [ ] Estuary coverage increases to 40%+
- [ ] All existing tests still pass

## Priority: CRITICAL

This is the **core feature** of the pub/sub layer. Without it, the entire estuary subscription system is non-functional.
