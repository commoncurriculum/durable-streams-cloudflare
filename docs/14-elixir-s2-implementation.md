# Chapter 14: S2 as the Stream Backend

An evaluation of [S2](https://github.com/s2-streamstore/s2) as the storage layer, replacing Cloudflare Durable Objects + SQLite + R2. Four architecture options — from direct client access to CDN-backed protocol adapter — analyzed against the actual goals and S2 pricing.

## Goals (Restated)

1. **Scalable writes off our database.** Spiky write traffic shouldn't touch Postgres. Object storage backing is ideal.
2. **No thundering herd on redeploy.** State must not live in app server memory. Clients must be able to reconnect without re-establishing subscriptions or hammering a database.
3. **Real-time client protocol.** SSE for live tail, long-poll for catch-up. Offline clients resume from their last position.

## S2 Auth Model

S2 has a granular access token system ([API docs](https://s2.dev/docs/api/protocol)). Each access token has a **scope** that controls:

| Scope field | What it controls | Examples |
|------------|-----------------|---------|
| `basins` | Which basins the token can access | `{ "exact": "my-basin" }` or `{ "prefix": "project-" }` |
| `streams` | Which streams within allowed basins | `{ "exact": "my-stream" }` or `{ "prefix": "user/alice/" }` |
| `op_groups.stream` | Read/write permissions at stream level | `{ "read": true, "write": false }` (read-only) |
| `ops` | Specific operations allowed | `["read", "check-tail"]` (read-only operations) |
| `auto_prefix_streams` | Namespace streams by token scope | Automatically prefixes stream names |
| `expires_at` | Token expiry | RFC 3339 timestamp |

**This means S2 supports per-stream, read-only tokens.** You can issue a token scoped to a single stream with read-only access — exactly what a browser client needs.

Example: issue a read-only token for a single stream:

```json
POST /access-tokens
{
  "id": "client-alice-stream-123",
  "scope": {
    "basins": { "exact": "my-project" },
    "streams": { "exact": "updates/stream-123" },
    "op_groups": {
      "stream": { "read": true, "write": false }
    }
  },
  "expires_at": "2026-03-01T00:00:00Z"
}
```

This token can only read from `updates/stream-123` in `my-project`. It can't write, list streams, or access other streams.

**Implication for architecture:** S2's auth model is more capable than initially assessed. The "no per-stream auth" concern from Option 1 is wrong — you *can* restrict clients to specific streams. The remaining questions are CORS support and whether you want to manage S2 token lifecycle vs. your own JWTs.

## S2 Natively Serves SSE

S2's read endpoint (`GET /streams/{stream}/records`) returns `text/event-stream` when the client sends `Accept: text/event-stream`. The SSE events have type `batch` (with records), `error`, or `ping` (keepalive). Each batch event has an `id` field in the format `seq_num,timestamp,count`.

This means **S2 is already an SSE server**. Clients can use `EventSource` directly against S2 (or against a proxy that forwards the SSE stream unchanged). No protocol translation needed for the SSE read path.

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

## Architecture Options

Options 1–3 below are building blocks. **[Option 4](#recommended-option-4--cdn--sse-fan-out-adapter) combines CDN collapsing + SSE fan-out to handle both modes at scale** — this is the recommended approach for production.

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
- **S2 access tokens in the client.** Requires issuing S2 tokens to browser clients. S2 tokens support per-stream scoping (via `AccessTokenScope.streams` with exact match or prefix), so you *can* restrict a client to specific streams with read-only or write-only access. However, token lifecycle management (issuing, expiring, revoking) falls on you.
- **No read fan-out.** Each client opens its own ReadSession → cost scales linearly with readers. **$432/mo at 10K readers.**
- **No CORS.** S2's managed API may not support browser CORS headers. Check with S2 — if not, you need a proxy regardless.

**Verdict:** More viable than previously stated due to per-stream auth. Works for **server-to-server** and potentially **browser clients** if S2 supports CORS. Cost at scale is the main concern.

### Option 2: Thin Protocol Adapter (Durable Streams ↔ S2)

A lightweight adapter that translates the Durable Streams HTTP protocol to S2 API calls. Clients use standard SSE/EventSource. The adapter handles auth and CORS. Note: S2 natively serves SSE (`Accept: text/event-stream`), so the adapter can pass through S2's SSE stream with minimal transformation.

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
| `POST /stream/:project/:stream` (append) | `POST /streams/{stream}/records` (Append) | Wrap body as S2 record, return `Stream-Next-Offset` from `ack.end.seq_num` |
| `GET /stream/:project/:stream?offset=N` (read) | `GET /streams/{stream}/records?seq_num=N` (Read) | Map `seq_num` ↔ offset. S2's integer `seq_num` replaces `readSeq_byteOffset` |
| `GET ...?live=long-poll` | Read with `wait=30` | S2's `wait` param = built-in long-poll (up to 60s) |
| `GET ...?live=sse` | `GET /streams/{stream}/records` with `Accept: text/event-stream` | S2 natively serves SSE. Adapter can pass through or reformat `id:` field |
| `HEAD /stream/:project/:stream` | `GET /streams/{stream}/records/tail` (CheckTail) | Return metadata as headers |
| `DELETE /stream/:project/:stream` | `DELETE /streams/{stream}` | Direct mapping |
| `Producer-Id` / `Producer-Epoch` / `Producer-Seq` | `match_seq_num` + `fencing_token` | S2's `match_seq_num` handles conditional appends. More complex epoch/seq would need adapter-side state. |
| `Stream-Cursor` (cache-busting) | Adapter generates | Required for CDN collapsing (Option 4). Adapter derives cursor deterministically from `seq_num` + `tail.seq_num` (see Chapter 6 for cursor design). |
| `Stream-Up-To-Date: true` | Inferred from `tail` in response | S2 returns `tail.seq_num` in read responses — adapter compares to last record's `seq_num` |
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

## Recommended: Option 4 — CDN + SSE Fan-Out Adapter

Options 1–3 each solve part of the problem. Option 4 combines them to handle **both SSE and long-poll at scale** — the same dual-mode approach the current Cloudflare implementation uses.

```
                    ┌─── CDN (Cloudflare / CloudFront / Fastly) ───┐
                    │                                               │
LP Client A ───────>│  Cache key: /stream/x?offset=42&cursor=y     │
LP Client B ───────>│  1 MISS → Adapter → S2, N-1 HITs → cached   │
LP Client C ───────>│  (request collapsing, Chapter 5-6)           │
                    └───────────────────────────────────────────────┘
                                         │ (cache MISS only)
                    ┌────────────────────┴──────────────────────┐
                    │           Adapter (~500 lines)             │
                    │                                            │
SSE Client D ──────>│  ┌─ SSE conn D ─┐                         │
SSE Client E ──────>│  ├─ SSE conn E ─┤ → 1 S2 ReadSession     │──> S2
SSE Client F ──────>│  └─ SSE conn F ─┘   per stream            │
                    │                                            │
                    │  Long-poll (on cache MISS):                │
                    │  → S2 Read with wait=30                    │
                    │  ← DS response + Stream-Cursor + Cache-Ctrl│
                    │                                            │
                    │  Auth + CORS + Protocol Translation        │
                    └───────────────────────────────────────────┘
                                         │
                                        S2
```

### How It Works (Both Modes)

**Long-poll path (CDN-collapsed):**
1. Client sends `GET /stream/x?offset=42&live=long-poll&cursor=y`.
2. CDN checks cache. HIT → return cached response (no adapter hit). MISS → forward to adapter.
3. Adapter calls S2 with `wait=30`. S2 holds until new data or timeout.
4. Adapter returns DS-format response with `Cache-Control: public, max-age=20` + rotated `Stream-Cursor`.
5. CDN caches response. Next N-1 clients at same offset+cursor get cache HITs.
6. **Result: 10K long-poll readers on 100 streams = ~100 adapter hits per cycle.** Same as current CF implementation.

**SSE path (in-process fan-out):**
1. Client sends `GET /stream/x?live=sse&offset=40`, `Accept: text/event-stream`.
2. CDN passes through (streaming responses aren't cacheable).
3. Adapter checks: is there already an S2 read session for this stream?
   - **Yes** → send catch-up from in-memory buffer, add client to broadcast list.
   - **No** → open ONE S2 read session from the requested offset, start broadcasting.
4. As records arrive from S2, adapter broadcasts to ALL connected SSE clients for that stream.
5. Last SSE client disconnects → adapter closes the S2 read session for that stream.
6. **Result: 10K SSE readers on 100 streams = 100 S2 read sessions.** Same collapse ratio.

**Catch-up reads (CDN-cached):**
- Mid-stream reads return `Cache-Control: public, max-age=60`. Data at a given offset is immutable. CDN caches.

**Writes:**
- POST passes through CDN (not cached) → adapter → S2.

### This Is the Same Architecture as the Current CF Implementation

| Layer | Cloudflare (current) | S2 + Adapter (Option 4) |
|-------|---------------------|------------------------|
| Long-poll fan-out | CDN request collapsing | CDN request collapsing (same mechanism) |
| SSE fan-out | DO Hibernation WS → edge worker → SSE | 1 S2 ReadSession per stream → adapter → N SSE clients |
| Write path | Edge → DO (SQLite) | Adapter → S2 (object storage) |
| State on redeploy | DO preserved, WS drops | S2 preserved, SSE drops (same) |
| Thundering herd (LP) | CDN absorbs | CDN absorbs (same) |
| Thundering herd (SSE) | Clients reconnect, DO already has data | Clients reconnect, adapter opens S2 session from their offset |

The key insight: **the CDN handles long-poll fan-out, the adapter handles SSE fan-out.** Neither alone solves both — you need the combination.

### Cost (Managed S2)

| Scenario | S2 ReadSessions | S2 cost/month | vs Cloudflare |
|----------|----------------|---------------|---------------|
| 10K LP readers, 100 streams | ~100 (CDN collapses) | **~$4** | Comparable (~$18 CF) |
| 10K SSE readers, 100 streams | 100 (fan-out collapses) | **~$4** | Comparable |
| 10K mixed (5K LP + 5K SSE), 100 streams | 100 SSE sessions + ~100 LP misses/cycle | **~$4-8** | Comparable |
| 100K mixed, 1K streams | 1K SSE sessions + ~1K LP misses/cycle | **~$43-86** | Better at scale (no per-req CF billing) |

**Both modes collapse to O(streams), not O(readers).** LP via CDN caching, SSE via in-process fan-out. This matches Cloudflare's economics.

### What the Adapter Holds in Memory (Per Active Stream)

- 1 S2 read session connection (opened on first SSE client, closed when last disconnects)
- List of connected SSE client handles
- Small ring buffer of recent records (for SSE catch-up and long-poll cache-miss handling)

This is transient, self-healing state — not subscription state. On redeploy:
- SSE clients auto-reconnect (`EventSource` built-in retry) with `Last-Event-ID`.
- First reconnecting client triggers a new S2 read session from their offset.
- No database query needed to rebuild state. S2 is the source of truth.

### Adapter Size Estimate

| Component | Lines | Stateful? |
|-----------|-------|-----------|
| Auth (JWT verification) | ~50 | No |
| CORS | ~20 | No |
| Protocol translation (DS ↔ S2) | ~100 | No |
| Long-poll handler (pass to S2 + DS headers) | ~80 | No |
| SSE fan-out (per-stream session + broadcast) | ~200 | Yes (per-stream) |
| Catch-up read handler | ~50 | No |
| **Total** | **~500** | |

~500 lines total. The SSE fan-out is the only stateful part, and it's the same pattern whether you use Elixir (GenServer per stream + PubSub), Go (goroutine per stream + channels), or Node (EventEmitter per stream).

### Why Elixir Is a Good Fit (But Not Required)

Elixir/BEAM excels here because the adapter needs to handle many concurrent long-lived connections (SSE) plus per-stream coordination (fan-out). Specifically:
- **Millions of lightweight processes** — one per SSE client + one per active stream. Trivial overhead.
- **Built-in broadcast** — `Phoenix.PubSub` or plain `send/2` to a list of PIDs.
- **Graceful connection handling** — process-per-connection model means a crashed client doesn't affect others.

But the adapter is ~500 lines. Go, Rust, or even a Cloudflare Worker with Durable Objects could do this too. Pick the language your team operates best.

## Recommendation Summary

| Scale | Recommended |
|-------|-------------|
| < 100 total concurrent readers | **Option 1** (direct S2) or **Option 2** (thin adapter) |
| 100–1K total | **Option 2** (thin adapter) |
| > 1K total (SSE + long-poll) | **Option 4** (CDN + SSE fan-out adapter) |
| Any scale with browser clients | **Option 2 or 4** (need auth + CORS) |

**For Common Curriculum:** You need both SSE and long-poll at scale → **Option 4**. It's the S2 equivalent of the current Cloudflare architecture: CDN collapses long-poll, adapter collapses SSE, both modes scale to O(streams) not O(readers).

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

S2 response: { "start": { "seq_num": 42 }, "end": { "seq_num": 43 }, "tail": { "seq_num": 43 } }

Adapter response: 204 No Content
                  Stream-Next-Offset: 43
```

### Read (Catch-Up)

```
Client: GET /v1/stream/myproject/mystream?offset=40

Adapter: GET https://s2/streams/mystream/records?start_seq_num=40&limit=100
         S2-Basin: ds-myproject

S2 response: { "records": [{ "seq_num": 40, "body": "...", "headers": [...] },
                            { "seq_num": 41, "body": "...", "headers": [...] }],
               "tail": { "seq_num": 43 } }

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
  - (Option 2) Opens S2 ReadSession for this client (1:1)
  - (Option 3) Joins existing per-stream fan-out, catches up from buffer
  - (Option 4) Joins existing per-stream fan-out (same as Option 3 for SSE)
  - S2 natively serves SSE (`Accept: text/event-stream`), so the per-stream
    S2 session receives native SSE events. Adapter reformats and broadcasts:

    S2 SSE events (from single per-stream session):
    event: batch
    id: 40,1708012345000,1
    data: {"records":[{"seq_num":40,"body":"...","headers":[...]}]}

    Adapter broadcasts to all connected SSE clients for this stream:
    id: 40
    data: {"text":"hello"}
```

### Long-Poll

```
Client: GET /v1/stream/myproject/mystream?offset=43&live=long-poll

Adapter:
  - (Option 2) S2 Read with wait=30
  - (Option 3) Check buffer, if at tail → park request, resolve when new data arrives
  - (Option 4) CDN handles caching. On cache MISS: S2 Read with wait=30,
               return with Stream-Cursor + Cache-Control headers

  If new data within 30s:
    200 OK + records + Stream-Next-Offset + Stream-Cursor + Cache-Control: public, max-age=20

  If timeout:
    204 No Content
    Stream-Up-To-Date: true
    Cache-Control: no-store
```

### Offset Mapping

Durable Streams uses `readSeq_byteOffset` format (e.g., `0000000000000001_0000000000001234`). S2 uses plain integer sequence numbers. The adapter can either:

1. **Use S2 seqNums directly** as offsets (simpler, breaks DS protocol compatibility).
2. **Wrap S2 seqNums in DS format** with a fixed `readSeq` of `0` (e.g., `0000000000000000_0000000000000042`). This preserves protocol compatibility — existing DS clients work unchanged.

### Producer Fencing

| DS Feature | S2 Equivalent | Gap? |
|-----------|---------------|------|
| `Producer-Id` + `Producer-Epoch` + `Producer-Seq` | `matchSeqNum` (conditional append) | S2's `matchSeqNum` is per-stream, not per-producer. For single-writer streams this is equivalent. For multi-producer, the adapter would need to track producer state. |
| Duplicate detection (same epoch+seq → idempotent 204) | `match_seq_num` rejects mismatched seq_num | Same effect for single-writer. |
| Fencing tokens | S2 `fencingToken` (native, up to 36 bytes) | Direct mapping. |

For the Common Curriculum use case (single writer per stream): `matchSeqNum` is sufficient. The adapter doesn't need to implement the full epoch/seq state machine.

## What's the Adapter Actually Doing? (Justification)

With Option 4, the adapter has five jobs:

1. **Auth + CORS** (~50 lines). Verify JWTs, add CORS headers. This is why clients can't hit S2 directly from browsers.

2. **Protocol translation** (~100 lines). Map Durable Streams HTTP protocol to S2 API. Headers, offsets, response format.

3. **SSE fan-out** (~200 lines). Collapse N SSE readers into 1 S2 read session per stream. Broadcast records to all connected clients. This is the economic justification for SSE — turns O(readers) cost into O(streams) cost.

4. **Long-poll handling** (~80 lines). On CDN cache MISS: call S2 with `wait` param, return DS-format response with `Stream-Cursor` + `Cache-Control` headers so CDN can cache it. CDN handles the fan-out for long-poll.

5. **SSE bridging** (~50 lines). Convert S2 read session records to `text/event-stream` format for clients.

Without #3, SSE costs scale linearly ($432/mo at 10K readers on managed S2). Without the CDN in front, long-poll costs scale linearly too. The combination gives you O(streams) for both modes.

## s2-lite Eliminates the Cost Argument

If you run **s2-lite** (self-hosted) instead of managed S2:
- No per-ReadSession cost → fan-out is still good practice (reduces s2-lite load), but not required for cost.
- **Option 2 (thin adapter)** works at any reader count if s2-lite can handle the throughput.
- **Option 4** is still recommended at high scale because CDN collapsing reduces load on s2-lite (throughput, not cost) and SSE fan-out avoids opening thousands of read sessions against a single-node server.
- s2-lite is single-node, so fan-out protects it from connection saturation even though sessions are free.

The decision tree:

```
Do you need SSE + long-poll at scale (>1K readers)?
├── Yes → Option 4 (CDN + SSE fan-out adapter)
│         ├── Managed S2 → cost-effective ($4-43/mo for both modes)
│         └── s2-lite → even cheaper (~$30/mo pod cost), CDN reduces s2-lite load
└── No (< 1K readers)
    ├── Need auth/CORS/protocol compat? → Option 2 (thin adapter)
    └── Server-to-server only? → Option 1 (direct S2)
```

## Comparison to Cloudflare Implementation

| Concern | Cloudflare (current) | S2 + Adapter (Option 4) |
|---------|---------------------|------------------------|
| Write path | Edge Worker → DO (SQLite tx) | Adapter → S2 (object storage) |
| Long-poll fan-out | CDN request collapsing | CDN request collapsing (same mechanism) |
| SSE fan-out | DO Hibernation WS → edge SSE bridge | 1 S2 ReadSession per stream → adapter broadcast |
| Long-poll | DO `LongPollQueue` + cache | S2 `wait` param + CDN caching |
| Durability | DO SQLite + R2 segments | S2 + object storage (SlateDB) |
| Cold storage | R2 segments | S2/SlateDB tiers to S3 internally |
| State on redeploy | DO state preserved (but WS connections drop) | S2 state preserved, SSE connections drop (same) |
| Thundering herd (LP) | CDN absorbs reconnect storm | CDN absorbs (same) |
| Thundering herd (SSE) | DO has data, WS reconnects | Adapter opens S2 session from client's offset |
| Auth | KV-stored JWT secrets ($32/mo at scale) | S2 per-stream tokens or adapter JWTs |
| Cost at 10K readers (mixed) | ~$18/mo (with CDN @ 99% HIT) | ~$4-43/mo (managed S2) or ~$30/mo (s2-lite) |

## Open Questions

1. **Managed S2 vs s2-lite?** Managed S2 has per-call pricing that Option 4 mitigates via CDN + SSE fan-out. s2-lite has no per-call cost but is single-node. For your K8s deployment, s2-lite backed by S3 may be the pragmatic choice — you control the infra and avoid per-minute read session charges.

2. **Is the Durable Streams protocol needed?** S2 natively serves SSE and supports long-poll via the `wait` parameter. If you're building new clients, S2's native protocol (via the TypeScript SDK or raw `EventSource`) may be sufficient. The protocol adapter is needed for CDN collapsing (requires DS-style cursor rotation) and for SSE fan-out (the adapter collapses N clients to 1 S2 session). S2's read sessions already provide the "offline → catch-up → live tail" flow natively.

3. **Which language for the adapter?** The ~500-line adapter needs SSE fan-out (stateful, concurrent connections). Elixir/BEAM excels here (lightweight processes, built-in broadcast). Go is also strong (goroutines + channels). For Options 1-2 (no fan-out), any language works.

4. **S2 CORS support?** If S2's managed API supports browser CORS headers, Option 1 (direct S2 access with per-stream tokens) becomes viable for browser clients without any middleware. Check with S2.