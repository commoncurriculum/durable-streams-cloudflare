# Call Graph: Durable Streams Architecture

## Path 1: External Client → Edge Worker → StreamDO (HTTP)

```
Client (POST /v1/stream/project/stream with body)
  │
  ↓ HTTP over internet
  │
┌─┴────────────────────────────────────────────────────────────┐
│ Edge Worker (router.ts)                                       │
│                                                               │
│ app.all("/v1/stream/*", async (c) => {                       │
│   const doKey = c.get("streamPath");  // "project/stream"    │
│   const stub = c.env.STREAMS.getByName(doKey);               │
│   return stub.routeStreamRequest(doKey, timing, c.req.raw);  │ ← RPC call
│ })                                                            │
└───────────────────────────────────────────────────────────────┘
  │
  ↓ RPC (passes Request object)
  │
┌─┴────────────────────────────────────────────────────────────┐
│ StreamDO (streams/index.ts)                                  │
│                                                               │
│ async routeStreamRequest(streamId, timing, request) {        │
│   return this.app.fetch(request, {streamId, timing});        │
│ }                                                             │
│   │                                                           │
│   ↓ Internal Hono routing                                    │
│   │                                                           │
│ app.post("*", async (c) => {                                 │
│   return handlePost(c.var.streamContext, streamId, request); │
│ })                                                            │
└───┬───────────────────────────────────────────────────────────┘
    │
    ↓
┌───┴───────────────────────────────────────────────────────────┐
│ handlePost (append/index.ts)                                  │
│                                                               │
│ 1. extractPostInput(request)        ← Read body from Request │
│ 2. parsePostInput(raw)                                        │
│ 3. validatePostInput(parsed, meta)                            │
│ 4. executePost(context, validated)                            │
│    ├─ buildAppendBatch()            ← Build SQLite batch     │
│    ├─ storage.batch(statements)     ← Write to SQLite        │
│    └─ broadcast to live readers                               │
│ 5. return Response                                            │
└───────────────────────────────────────────────────────────────┘
```

**Key Points:**

- Edge worker is thin: auth, CORS, routing
- StreamDO receives the original Request object
- handlePost extracts data from Request and does the work

---

## Path 2: SubscriptionDO → StreamDO (Internal RPC)

```
┌────────────────────────────────────────────────────────────┐
│ SubscriptionDO.publish()                                    │
│                                                             │
│ const stub = this.env.STREAMS.get(                         │
│   this.env.STREAMS.idFromName(streamId)                    │
│ );                                                          │
│                                                             │
│ const result = await stub.appendToStream(                  │
│   streamId,                                                 │
│   new Uint8Array(payload)                                  │
│ );  ←──────────────────────────────────── RPC call (NO HTTP!)  │
└────────────────────────────────────────────────────────────┘
  │
  ↓ Direct RPC call (same datacenter, no edge worker)
  │
┌─┴──────────────────────────────────────────────────────────┐
│ StreamDO.appendToStream() (streams/index.ts)               │
│                                                             │
│ async appendToStream(streamId, payload) {                  │
│   return this.ctx.blockConcurrencyWhile(async () => {      │
│     // 1. Validate stream exists and not closed            │
│     const meta = await getStream(streamId);                │
│     if (!meta || meta.closed) throw error;                 │
│                                                             │
│     // 2. Build append batch (SQL statements)              │
│     const batch = await buildAppendBatch(                  │
│       this.storage,                                         │
│       streamId,                                             │
│       meta.content_type,                                    │
│       payload,                                              │
│       {}                                                    │
│     );                                                      │
│                                                             │
│     // 3. Write to SQLite                                  │
│     await this.storage.batch(batch.statements);            │
│                                                             │
│     // 4. Notify live readers                              │
│     this.longPoll.notify(batch.newTailOffset, 0);          │
│                                                             │
│     // 5. Broadcast to SSE/WebSocket if any connected      │
│     if (this.sseState.clients.size > 0 ||                  │
│         this.ctx.getWebSockets().length > 0) {             │
│       await broadcastSse(...);                             │
│       await broadcastWebSocket(...);                       │
│     }                                                       │
│                                                             │
│     // 6. Schedule rotation                                │
│     this.ctx.waitUntil(rotateSegment(...));                │
│                                                             │
│     return { tailOffset: batch.newTailOffset };            │
│   });                                                       │
│ }                                                           │
└─────────────────────────────────────────────────────────────┘
```

**✅ Clean RPC Design:**

- Direct storage operations - no fake Request
- Uses the same building blocks (buildAppendBatch, broadcast, etc.)
- No HTTP overhead - just does the work
- Returns exactly what's needed: `{ tailOffset }`

---

## ✅ Clean Architecture (After Refactor)

### RPC Path (Current):

```
SubscriptionDO
  ↓ appendToStream(payload)
StreamDO.appendToStream()
  ↓ blockConcurrencyWhile
  ↓ getStream (validate)
  ↓ buildAppendBatch (build SQL)
  ↓ storage.batch (write SQLite)
  ↓ longPoll.notify (wake waiters)
  ↓ broadcast (if live readers)
  ↓ rotateSegment (background)
  ↓ return { tailOffset }
Back to SubscriptionDO
```

**No fake Requests. No HTTP overhead. Just direct operations.**

---

## Why Two Paths Exist

**Path 1 (HTTP):** For external clients

- Needs: Auth, CORS, edge caching, HTTP protocol
- Goes through: Edge Worker → DO → handlePost

**Path 2 (RPC):** For internal DO-to-DO calls

- Needs: Just the data write operation
- Goes through: SubscriptionDO → StreamDO RPC method
- **Should NOT** go through HTTP handler machinery

---

## Dependency Graph (Key Files)

```
router.ts (edge worker)
  ├─→ middleware/
  │     ├─→ authentication.ts
  │     ├─→ cors.ts
  │     └─→ edge-cache.ts
  └─→ streams/index.ts (StreamDO)
        ├─→ append/index.ts (handlePost)
        │     ├─→ append/parse.ts
        │     ├─→ append/validate.ts
        │     └─→ append/execute.ts
        │           └─→ storage.batch()
        ├─→ create/index.ts (handlePut)
        ├─→ read/index.ts (handleGet)
        └─→ delete/index.ts (handleDelete)

subscriptions/do.ts (SubscriptionDO)
  └─→ streams/index.ts (StreamDO) via RPC
        └─→ appendToStream() method
              ├─→ buildAppendBatch()
              ├─→ storage.batch()
              ├─→ broadcast functions
              └─→ rotateSegment()
```

---

## ✅ Implemented Solution: Direct RPC Operations

We chose **Option 1** - Direct storage access in RPC methods.

```typescript
// streams/index.ts - StreamDO.appendToStream()
async appendToStream(streamId, payload) {
  return this.ctx.blockConcurrencyWhile(async () => {
    const meta = await getStream(this.storage, this.env, streamId);
    if (!meta || meta.closed) throw error;

    const batch = await buildAppendBatch(
      this.storage, streamId, meta.content_type, payload, {}
    );
    await this.storage.batch(batch.statements);
    this.longPoll.notify(batch.newTailOffset, 0);

    if (this.sseState.clients.size > 0 ||
        this.ctx.getWebSockets().length > 0) {
      await broadcastSse(...);
      await broadcastWebSocket(...);
    }

    this.ctx.waitUntil(rotateSegment(...));

    return { tailOffset: batch.newTailOffset };
  });
}
```

**Result:**

- ✅ No fake Request objects
- ✅ No manual context building
- ✅ Direct, honest operations
- ✅ Shares building blocks (buildAppendBatch, broadcast, etc.)
- ✅ Each path optimized for its use case
