# Architecture

## Overview

A single Cloudflare Worker routes all traffic to a **Durable Object per stream**. The DO is the single-threaded sequencer — it orders all writes and serves all reads. **DO SQLite** is the durable hot log. **R2** stores immutable cold segments. Real-time delivery uses an **internal WebSocket bridge** between the edge worker and the DO, enabling DO hibernation between writes.

```
                          ┌──────────────────────────────────────────────────┐
                          │                   Edge Worker                    │
   Client ───────────────>│  Auth · CORS · Edge Cache · SSE Bridge · Route  │
                          └──────────────┬───────────────────────────────────┘
                                         │
                                         v
                          ┌──────────────────────────────────────────────────┐
                          │               StreamDO (per stream)              │
                          │                                                  │
                          │  SQLite hot log ·····> R2 cold segments          │
                          │  (writes, reads)       (rotation on threshold)   │
                          │                                                  │
                          │  Hibernation API WebSockets (live readers)       │
                          └──────────────────────────────────────────────────┘
```

## Request Flow

### Writes (PUT / POST / DELETE)

1. Edge worker (`create_worker.ts`) validates auth, applies CORS, and routes to the stream's DO via `stub.routeStreamRequest()`.
2. StreamDO runs the handler inside `blockConcurrencyWhile()` for single-writer ordering.
3. SQLite transaction: assign offsets, insert ops, update metadata. ACK only after commit.
4. Broadcast to all connected live readers (WebSocket, SSE, long-poll).
5. Schedule segment rotation to R2 if thresholds are exceeded.

### Catch-Up Reads (GET)

1. Edge worker checks the edge cache (`caches.default`). On hit, return cached response.
2. On miss, route to the DO. The DO resolves the offset, reads from SQLite (hot) or R2 (cold), returns the response with `Cache-Control` and `ETag` headers.
3. Edge worker stores immutable mid-stream responses in the cache for the next reader.

### SSE Live Reads (GET ?live=sse)

1. Edge worker validates auth, then opens an **internal WebSocket** to the DO (`?live=ws-internal`).
2. The DO creates a `WebSocketPair`, accepts the server side via the Hibernation API, sends catch-up data, and returns the client side.
3. Edge worker bridges WebSocket messages to SSE events on a `TransformStream`.
4. On new writes, the DO wakes from hibernation, broadcasts to all WebSocket clients, then sleeps again.
5. Client sees standard SSE — `EventSource` works unchanged.

### Long-Poll Reads (GET ?live=long-poll)

1. Edge worker routes to DO. DO checks for new data.
2. If data is available, return immediately.
3. If at tail, park the request in a `LongPollQueue` with a timeout.
4. When a write arrives (or timeout fires), resolve the parked request.

## Key Modules

### Edge Layer (`src/http/`)

| File | Role |
|------|------|
| `create_worker.ts` | Edge worker factory — auth, CORS, edge caching, SSE-via-WebSocket bridge, routing to DO |
| `worker.ts` | `WorkerEntrypoint` subclass — HTTP entry point + RPC methods for service bindings |
| `durable_object.ts` | `StreamDO` class — storage wiring, `StreamContext` construction, Hibernation API handlers, `blockConcurrencyWhile` |
| `router.ts` | Method dispatch (`PUT`/`POST`/`GET`/`HEAD`/`DELETE`) + `StreamContext` type |
| `hono.ts` | CORS helpers |
| `handlers/read.ts` | `GET`/`HEAD` — offset resolution, cache headers, ETag, WebSocket upgrade (`?live=ws-internal`) |
| `handlers/write.ts` | `PUT`/`POST`/`DELETE` — validation, execution, broadcast to all transports |
| `handlers/realtime.ts` | Long-poll (`LongPollQueue`), SSE (`SseState`), WebSocket bridge (`WsAttachment`), broadcast functions |

### Stream Logic (`src/stream/`)

| File | Role |
|------|------|
| `create/*` | PUT pipeline: parse, validate, execute |
| `append/*` | POST pipeline: parse, validate, execute |
| `read/path.ts` | Hot log reads, R2 segment reads, read coalescing |
| `read/from_offset.ts`, `from_messages.ts`, `result.ts` | Read helpers |
| `producer.ts` | Producer fencing and idempotency (epoch/seq) |
| `rotate.ts` | Flush hot ops to R2, advance `read_seq` |
| `offsets.ts` | Offset parsing/validation, `Stream-Next-Offset` encoding |
| `close.ts` | Close-only semantics |
| `content_strategy.ts` | JSON vs binary serialization |
| `shared.ts` | Content-Length / body size validation |

### Storage (`src/storage/`)

| File | Role |
|------|------|
| `queries.ts` | `DoSqliteStorage` — all SQLite operations |
| `types.ts` | `StreamStorage` interface + types |
| `segments.ts` | R2 key encoding + length-prefixed framing |

### Protocol (`src/protocol/`)

Headers, offsets, cursors, JSON helpers, limits, timing (`Server-Timing` instrumentation).

## Data Model (per-stream DO SQLite)

| Table | Contents |
|-------|----------|
| `stream_meta` | Content type, tail offset, TTL/expiry, closed state, segment counters |
| `ops` | Append log — offset, payload, seq, producer info |
| `producers` | Producer id → epoch/seq tracking, last offset, last updated |
| `segments` | R2 segment records — start/end offsets, read_seq, R2 key, size |

## Cold Storage / Segment Rotation

The DO compacts the hot log into length-prefixed **R2 segments** when thresholds are hit (`segmentMaxMessages` default 1000, `segmentMaxBytes` default 4 MB) or on stream close. After writing the segment to R2:

1. Insert a `segments` row with the R2 key and offset range.
2. Increment `read_seq` — this advances the offset encoding epoch.
3. Reset segment counters.

Catch-up reads prefer R2 segments when available. The hot log only serves the current (in-progress) segment.

## Real-Time Delivery

### Internal WebSocket Bridge

SSE connections use an internal WebSocket between the edge worker and the DO:

```
Client ←── SSE ──── Edge Worker ←── WebSocket (Hibernation API) ──── StreamDO
                    (CPU-time billing,                                (sleeps between
                     idle = $0)                                       writes)
```

**Connection flow:**

1. Client requests `?live=sse`.
2. Edge worker builds a WebSocket upgrade request with `?live=ws-internal` and calls `stub.fetch()`.
3. DO creates a `WebSocketPair`, accepts the server side via `this.ctx.acceptWebSocket(server, [streamId])`, and sends catch-up data as WebSocket messages.
4. Edge worker receives the client WebSocket, opens an SSE `TransformStream`, and bridges WS messages → SSE events.

**Live broadcast:**

When a write arrives (POST), the DO wakes from hibernation, processes the write, then calls `this.ctx.getWebSockets()` to broadcast to all connected edge workers. Each edge worker translates the WebSocket message to an SSE event for its client. After the POST handler returns, the DO has no pending work — only hibernatable WebSocket connections remain — and billing stops.

**WebSocket message format** (DO → edge, JSON text frames):

| Type | Shape | Notes |
|------|-------|-------|
| Data | `{ "type": "data", "payload": "...", "encoding": "base64" }` | `encoding` omitted for text content types |
| Control | `{ "type": "control", "streamNextOffset": "...", "upToDate": true, "streamClosed": false, "streamCursor": "..." }` | Sent after every data message, and standalone for close events |

**Per-connection state** is persisted across hibernation via `ws.serializeAttachment()` / `ws.deserializeAttachment()`:

```ts
type WsAttachment = {
  offset: number;        // Current read position (internal numeric offset)
  contentType: string;   // Stream content type
  useBase64: boolean;    // Whether to base64-encode binary payloads
  cursor: string;        // Client cursor for cache-busting
  streamId: string;      // Needed after hibernation wake
};
```

### Long-Poll

Long-poll requests park at the DO in a `LongPollQueue` with a timeout. Responses include protocol-correct `Cache-Control: public, max-age=20` headers. DO-level in-flight coalescing and a recent-read cache (100ms TTL, auto-invalidated by `meta.tail_offset`) deduplicate concurrent requests.

### DO Hibernation

The Hibernation API lets the DO sleep while holding WebSocket connections. Cloudflare does not bill for DO duration while hibernating. The DO wakes only when:

- A write request arrives (POST/PUT/DELETE)
- A new WebSocket connection is established
- A WebSocket message is received

After processing, if only hibernatable WebSocket connections remain (no active HTTP requests, no timers, no in-flight fetches), the DO returns to hibernation immediately.

## Registry Stream

The worker emits create/delete events to a system stream (`__registry__`) for clients that need discovery or monitoring.
