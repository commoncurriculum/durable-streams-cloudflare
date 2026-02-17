# Chapter 14: S2 as the Stream Backend

An evaluation of [S2](https://github.com/s2-streamstore/s2) as the storage layer, replacing Cloudflare Durable Objects + SQLite + R2. Three architecture options — from direct client access to a thin protocol adapter — analyzed against the actual goals and S2 pricing.

## Goals (Restated)

1. **Scalable writes off our database.** Spiky write traffic shouldn't touch Postgres. Object storage backing is ideal.
2. **No thundering herd on redeploy.** State must not live in app server memory. Clients must be able to reconnect without re-establishing subscriptions or hammering a database.
3. **Real-time client protocol.** SSE for live tail, long-poll for catch-up. Offline clients resume from their last position.

## S2 Pricing Reality

From [s2.dev/pricing](https://s2.dev/pricing):

| Operation | Cost |
|-----------|------|
| Append | $0.0000001 |
| AppendSession | $0.0000001 / minute |
| Read | $0.0000010 |
| **ReadSession** | **$0.0000010 / minute** |
| CheckTail | $0.0000001 |
| CreateStream | $0.00001 |

The per-request charge for appends is waived for subsequent requests within a minute to the same stream over the same connection (append sessions amortize well).

### Cost at Scale

The critical number: **ReadSession at $0.000001/minute.** Every open read session is metered per minute. This directly maps to concurrent SSE readers.

| Concurrent SSE readers | Read session cost/month | Compare to Cloudflare |
|------------------------|------------------------|-----------------------|
| 100 | 100 readers × 43,200 min/mo = $4.32 | — |
| 1,000 | $43.20 | ~$18 (CF with CDN) |
| 10,000 | **$432.00** | ~$18 (CF with CDN) |
| 100,000 | **$4,320.00** | ~$18 (CF with CDN) |

**This is the same problem as DO duration billing** (Chapter 2). If every SSE client opens its own S2 read session, costs scale linearly with readers. Cloudflare solves this with CDN request collapsing — 10K readers share one cache entry. We need the same trick for S2.

Writes are cheap. At 1 write/second for 30 days:
- Appends: 2.6M × $0.0000001 = **$0.26/month** (negligible)
- Using AppendSession (1 per stream): 43,200 min × $0.0000001 = **$0.004/month** (negligible)

**The cost problem is reads, not writes.**

## Three Architecture Options

### Option 1: Clients Hit S2 Directly (No Middleware)

```
Client ────> S2 (managed)
             │
             └──> Object Storage (S3/Tigris)
```

Clients use the [S2 TypeScript SDK](https://github.com/s2-streamstore/s2-sdk-typescript) directly from the browser.

```typescript
import { S2, AppendInput, AppendRecord } from "@s2-dev/streamstore";

const s2 = new S2({
  accountEndpoint: "https://your-basin.b.s2.dev",
  accessToken: process.env.S2_TOKEN,
});

const stream = s2.basin("my-project").stream("my-stream");

// Write
await stream.append(AppendInput.create([
  AppendRecord.string({ body: JSON.stringify({ text: "hello" }) }),
]));

// Live tail (SSE-like: async iterable that waits for new data)
const session = await stream.readSession({
  start: { from: { seqNum: lastKnownSeqNum } },
});
for await (const record of session) {
  console.log(record.seqNum, record.body);
}
```

**Pros:**
- Zero custom code. No server to deploy or maintain.
- S2 handles writes, reads, tailing, durability, ordering.
- No thundering herd — no app server to redeploy.
- Managed S2 scales horizontally.

**Cons:**
- **S2 access tokens in the client.** Multi-tenant auth (per-project JWTs) doesn't map to S2's token model. Every client gets a token that can access S2 directly.
- **No per-stream auth.** S2 access tokens are scoped to basins, not individual streams. Can't restrict a client to a single stream.
- **No read fan-out.** Each client opens its own ReadSession → cost scales linearly with readers. **$432/mo at 10K readers.**
- **S2 protocol, not Durable Streams protocol.** Clients must use S2's SDK instead of SSE/EventSource.
- **No CORS.** S2 may not support browser CORS headers on its API.

**Verdict:** Works for **server-to-server** use cases (backend services consuming streams). **Not viable for browser clients** due to auth, CORS, and cost at scale.

### Option 2: Thin Protocol Adapter (Durable Streams ↔ S2)

A lightweight adapter that translates the Durable Streams HTTP protocol to S2 API calls. Clients use standard SSE/EventSource. The adapter handles auth and CORS.

```
Client ── (Durable Streams protocol) ──> Adapter ── (S2 API) ──> S2
                                          │
                                          ├── Auth (JWT verification)
                                          ├── CORS
                                          └── Protocol translation
```

**Protocol mapping (Durable Streams → S2):**

| Durable Streams | S2 Equivalent | Adapter Logic |
|----------------|---------------|---------------|
| `PUT /stream/:project/:stream` (create) | `POST /streams` (CreateStream) | Map project to S2 basin, stream name 1:1 |
| `POST /stream/:project/:stream` (append) | `POST /streams/{stream}/records` (Append) | Wrap body as S2 record, return `Stream-Next-Offset` from `ack.end.seqNum` |
| `GET /stream/:project/:stream?offset=N` (read) | `GET /streams/{stream}/records?start_seq_num=N` (Read) | Map `seqNum` ↔ offset. S2's integer seqNum replaces `readSeq_byteOffset` |
| `GET ...?live=long-poll` | Read with `wait_secs=30` | S2's `waitSecs` = built-in long-poll |
| `GET ...?live=sse` | ReadSession (streaming) | Bridge S2 read session → SSE `text/event-stream`. S2 `seqNum` → SSE `id:` |
| `HEAD /stream/:project/:stream` | `GET /streams/{stream}` (CheckTail) | Return metadata as headers |
| `DELETE /stream/:project/:stream` | `DELETE /streams/{stream}` | Direct mapping |
| `Producer-Id` / `Producer-Epoch` / `Producer-Seq` | `matchSeqNum` + fencing tokens | S2's `matchSeqNum` handles conditional appends. More complex epoch/seq would need adapter-side state. |
| `Stream-Cursor` (cache-busting) | Not needed | No CDN caching layer to bust |
| `Stream-Up-To-Date: true` | Inferred from empty read or tail position | Adapter compares `seqNum` to `checkTail()` |
| `Stream-Closed` | S2 `trim` command record | Use S2's command records for close semantics |

The adapter is a thin HTTP server: ~300 lines in any language. Could be:
- **Elixir/Phoenix** — if you're deploying on K8s and want BEAM's connection handling
- **Cloudflare Worker** — if you want to stay in the CF ecosystem (no K8s needed)
- **Node.js/Bun** — minimal deps, fast to build
- **Go** — if your team prefers it

**Pros:**
- Clients use standard SSE (`EventSource`) — no S2 SDK needed.
- Auth and CORS are handled by your code, not S2.
- Durable Streams protocol compatibility — existing clients work unchanged.
- Adapter is stateless and tiny.
- No thundering herd — adapter has no in-memory state.

**Cons:**
- **Still 1:1 ReadSession per SSE client** if the adapter naively bridges each connection to its own S2 read session. **Same $432/mo cost at 10K readers.**
- Adds a network hop.

**Verdict:** Solves auth, CORS, and protocol compatibility. **Does NOT solve the read cost problem** unless combined with read fan-out (Option 3).

### Option 3: Protocol Adapter + Read Fan-Out

Same as Option 2, but the adapter collapses multiple readers into a single S2 read session per stream. This is the **exact same insight as CDN request collapsing** from Chapter 6.

```
                      ┌──────────────────────────────────┐
                      │        Adapter (stateful)         │
                      │                                   │
SSE Client A ────────>│  ┌─ SSE conn A ─┐                │
SSE Client B ────────>│  ├─ SSE conn B ─┤  1 S2 ReadSession  ──> S2
SSE Client C ────────>│  └─ SSE conn C ─┘  per stream    │
                      │                                   │
Long-poll D ─────────>│  Read from in-memory buffer       │
Long-poll E ─────────>│  (last N records cached)          │
                      └──────────────────────────────────┘
```

**How it works:**
1. First SSE client for a stream → adapter opens ONE S2 read session for that stream.
2. Records from S2 arrive → adapter broadcasts to ALL connected SSE clients for that stream.
3. New SSE client connects → adapter sends catch-up from the in-memory buffer, then adds it to the broadcast list.
4. Last SSE client disconnects → adapter closes the S2 read session.
5. Long-poll clients read from the in-memory buffer. If at tail, the adapter parks them and resolves when new data arrives from the S2 session.

**Cost impact:**

| Concurrent SSE readers | S2 ReadSessions | Cost/month | vs Option 1/2 |
|------------------------|----------------|------------|----------------|
| 10K readers, 100 streams | **100 sessions** (1 per stream) | **$4.32** | 100x cheaper |
| 10K readers, 1K streams | **1,000 sessions** | **$43.20** | 10x cheaper |
| 100K readers, 1K streams | **1,000 sessions** | **$43.20** | 100x cheaper |

Read cost becomes proportional to **active streams**, not **active readers**. This is the same economics as Cloudflare's CDN collapsing.

**What the adapter needs to hold in memory (per active stream):**
- 1 S2 read session connection
- List of connected SSE client PIDs/handles
- Small buffer of recent records (for catch-up and long-poll)

**This is in-memory state — does that break the "no thundering herd" goal?**

No. Here's why:

| Concern | Why it's fine |
|---------|--------------|
| Redeploy drops SSE connections | SSE clients reconnect automatically (`EventSource` has built-in retry). Client sends `Last-Event-ID: <seqNum>`. |
| New instance has empty buffers | First reconnecting client triggers a new S2 read session from their `seqNum`. Buffer fills instantly. |
| No subscription state to rebuild | The SSE connections ARE the subscriptions. No database of "who subscribes to what" to reconstruct. |
| No data loss | All data is in S2. The adapter buffer is just a cache. |
| Load balancer distributes reconnects | N clients across M instances = N/M connections per instance. Each instance independently opens S2 sessions as needed. |

The "thundering herd" in the old model was: app restart → clients reconnect → app queries DB for subscriptions → DB overloaded. Here: app restart → clients reconnect → app opens S2 read sessions (not our DB) → S2 handles it.

**Why Elixir is a good fit for this (but not required):**
- BEAM handles millions of concurrent connections per node (SSE = long-lived HTTP connections).
- Lightweight processes: one per SSE client + one per active stream session → trivial overhead.
- Built-in broadcast: `Phoenix.PubSub` or plain `send/2` to a list of PIDs.
- But this could also be Go, Rust, or even a Cloudflare Worker with Durable Objects (ironic but true).

**Pros:**
- Read cost collapsed from O(readers) to O(streams).
- Auth, CORS, and protocol translation included.
- Durable Streams protocol compatible.
- No thundering herd — transient connection state only, reconstructed on reconnect from S2.
- Multi-instance scaling.

**Cons:**
- More complex than Option 2 (~500-800 lines vs ~300 lines).
- In-memory per-stream state (but transient and self-healing).
- Need to handle the fan-out correctness (ordering, catch-up, buffer management).

**Verdict: This is the architecture that makes S2 economically viable at scale.** Without read fan-out, S2's per-minute ReadSession pricing makes it more expensive than Cloudflare at >1K readers.

## Recommendation

| Scale (total concurrent readers) | Recommended Option |
|-------|-------------------|
| < 100 total | **Option 1** (direct S2, server-to-server) or **Option 2** (thin adapter) |
| 100–1K total | **Option 2** (thin adapter, ~$4-43/mo in read sessions) |
| > 1K total | **Option 3** (adapter + read fan-out) |
| Any scale with browser clients | **Option 2 or 3** (need auth + CORS) |

For Common Curriculum's use case: if you have browser clients and anticipate >100 concurrent readers per stream, go directly to **Option 3**.

## s2-lite vs Managed S2

All the cost analysis above is for **managed S2** (per-API-call pricing). **s2-lite** (self-hosted) has no per-call pricing — you only pay for the K8s pod and S3 storage.

| | Managed S2 | s2-lite |
|---|---|---|
| ReadSession cost | $0.000001/min | $0 (self-hosted) |
| Scaling | Horizontal, managed | Single-node binary |
| Ops | Zero | You manage it |
| 10K readers (no fan-out) | $432/mo | ~$30/mo (pod cost) |
| 10K readers (with fan-out) | $4-43/mo | ~$30/mo (pod cost) |

**With s2-lite, the economics change completely.** You don't need read fan-out for cost reasons — each client can have its own read session against s2-lite at no additional per-call cost. The only limit is s2-lite's throughput (single-node, but handles substantial load with SlateDB).

This means:
- **s2-lite + Option 2 (thin adapter)** is viable even at 10K readers, because there's no per-session pricing.
- The trade-off is operational: you run s2-lite yourself, handle its availability, and accept the single-node constraint.
- s2-lite restarts are safe — SlateDB replays from object storage.

**For dev/test:** s2-lite in-memory mode (no S3 dependency, `docker run -p 8080:80 ghcr.io/s2-streamstore/s2 lite`).

## Protocol Adapter: Implementation Sketch

Regardless of which option you choose, the protocol adapter layer is the same. Here's the mapping in detail:

### Append (Write)

```
Client: POST /v1/stream/myproject/mystream
        Content-Type: application/json
        Body: { "text": "hello" }

Adapter: POST https://s2/streams/mystream/records
         S2-Basin: ds-myproject
         Body: { "records": [{ "body": "eyJ0ZXh0IjoiaGVsbG8ifQ==",  // base64("{"text":"hello"}")
                               "headers": [["content-type", "application/json"]] }] }

S2 response: { "start": { "seqNum": 42 }, "end": { "seqNum": 43 }, "tail": { "seqNum": 43 } }

Adapter response: 204 No Content
                  Stream-Next-Offset: 43
```

### Read (Catch-Up)

```
Client: GET /v1/stream/myproject/mystream?offset=40

Adapter: GET https://s2/streams/mystream/records?start_seq_num=40&limit=100
         S2-Basin: ds-myproject

S2 response: { "records": [{ "seqNum": 40, "body": "...", "headers": [...] },
                            { "seqNum": 41, "body": "...", "headers": [...] }],
               "tail": { "seqNum": 43 } }

Adapter response: 200 OK
                  Stream-Next-Offset: 42
                  Content-Type: application/json
                  Body: [decoded records]
```

### SSE (Live Tail)

```
Client: GET /v1/stream/myproject/mystream?live=sse&offset=40
        Accept: text/event-stream

Adapter:
  - (Option 2) Opens S2 ReadSession for this client
  - (Option 3) Joins existing per-stream fan-out, catches up from buffer
  - Bridges to SSE:

    id: 40
    data: {"text":"hello"}

    id: 41
    data: {"text":"world"}

    ... (keeps streaming as new records arrive)
```

### Long-Poll

```
Client: GET /v1/stream/myproject/mystream?offset=43&live=long-poll

Adapter:
  - (Option 2) S2 Read with wait_secs=30
  - (Option 3) Check buffer, if at tail → park request, resolve when new data arrives

  If new data within 30s:
    200 OK + records + Stream-Next-Offset

  If timeout:
    204 No Content
    Stream-Up-To-Date: true
```

### Offset Mapping

Durable Streams uses `readSeq_byteOffset` format (e.g., `0000000000000001_0000000000001234`). S2 uses plain integer sequence numbers. The adapter can either:

1. **Use S2 seqNums directly** as offsets (simpler, breaks DS protocol compatibility).
2. **Wrap S2 seqNums in DS format** with a fixed `readSeq` of `0` (e.g., `0000000000000000_0000000000000042`). This preserves protocol compatibility — existing DS clients work unchanged.

### Producer Fencing

| DS Feature | S2 Equivalent | Gap? |
|-----------|---------------|------|
| `Producer-Id` + `Producer-Epoch` + `Producer-Seq` | `matchSeqNum` (conditional append) | S2's `matchSeqNum` is per-stream, not per-producer. For single-writer streams this is equivalent. For multi-producer, the adapter would need to track producer state. |
| Duplicate detection (same epoch+seq → idempotent 204) | `matchSeqNum` rejects mismatched seqNum | Same effect for single-writer. |
| Fencing tokens | S2 `fencingToken` (native, up to 36 bytes) | Direct mapping. |

For the Common Curriculum use case (single writer per stream): `matchSeqNum` is sufficient. The adapter doesn't need to implement the full epoch/seq state machine.

## What's Elixir Actually Doing? (Justification)

With Option 3, the adapter has four jobs:

1. **Auth + CORS** (~50 lines). Verify JWTs, add CORS headers. This is why clients can't hit S2 directly from browsers.

2. **Protocol translation** (~100 lines). Map Durable Streams HTTP protocol to S2 API. Headers, offsets, response format.

3. **Read fan-out** (~200 lines). Collapse N readers into 1 S2 read session per stream. This is the economic justification — turns O(readers) cost into O(streams) cost.

4. **SSE bridging** (~50 lines). Convert S2 read session records to `text/event-stream` format.

Without #3, you don't need a middleware layer — clients could hit S2 directly (Option 1) or through a trivial proxy (Option 2). **Read fan-out is the reason the middleware exists.**

If your reader count stays under ~100 per stream, skip to Option 2 and save the complexity.

## s2-lite Eliminates the Cost Argument

If you run **s2-lite** (self-hosted) instead of managed S2:
- No per-ReadSession cost → no need for read fan-out for cost reasons.
- **Option 2 (thin adapter) becomes sufficient at any reader count**, as long as s2-lite can handle the throughput.
- The adapter's only jobs are auth, CORS, and protocol translation.
- s2-lite is single-node, but for your expected load, a single instance handles it.

The decision tree:

```
Are you using managed S2?
├── Yes → Do you have >1K total concurrent readers?
│         ├── Yes → Option 3 (adapter + read fan-out)
│         └── No  → Option 2 (thin adapter)
└── No (s2-lite) → Option 2 (thin adapter, any reader count)
```

## Comparison to Cloudflare Implementation

| Concern | Cloudflare (current) | S2 + Adapter |
|---------|---------------------|--------------|
| Write path | Edge Worker → DO (SQLite tx) | Adapter → S2 (object storage) |
| Read fan-out | CDN request collapsing ($0 per HIT) | Option 3: in-process fan-out (1 S2 session per stream) |
| SSE | Internal WS bridge + DO Hibernation | S2 ReadSession → SSE bridge |
| Long-poll | DO `LongPollQueue` + cache | S2 `waitSecs` or adapter buffer |
| Durability | DO SQLite + R2 segments | S2 + object storage (SlateDB) |
| Cold storage | R2 segments | S2/SlateDB tiers to S3 internally |
| State on redeploy | DO state preserved (but WS connections drop) | S2 state preserved, SSE connections drop (same) |
| Thundering herd | CDN absorbs reconnect storm | S2 absorbs reads (or s2-lite handles locally) |
| Auth | KV-stored JWT secrets ($32/mo at scale) | Env vars / K8s secrets ($0) |
| Cost at 10K readers | ~$18/mo (with CDN @ 99% HIT) | ~$4-43/mo (managed S2 + fan-out) or ~$30/mo (s2-lite) |

## Open Questions

1. **Managed S2 vs s2-lite?** Managed S2 has per-call pricing that hurts at high reader counts (unless you build fan-out). s2-lite has no per-call cost but is single-node. For your K8s deployment, s2-lite backed by S3 may be the pragmatic choice — you control the infra and avoid per-minute read session charges.

2. **Is the Durable Streams protocol needed?** If you're building new clients, S2's native protocol (via the TypeScript SDK) is simpler. The protocol adapter is only needed if you want `EventSource` compatibility or have existing DS clients. S2's `readSession` already provides the "offline → catch-up → live tail" flow natively.

3. **Which language for the adapter?** Elixir shines for Option 3 (BEAM handles millions of connections for fan-out). For Option 2, any language works — the adapter is ~300 lines of HTTP plumbing. A Cloudflare Worker would even work for Option 2 (zero infra to manage).

4. **Single-writer or multi-writer?** S2's `matchSeqNum` + fencing tokens cover single-writer idempotency. Multi-producer (multiple independent writers to the same stream with epoch/seq) would require adapter-side state, which is more complex. If your use case is single-writer-per-stream, keep it simple.