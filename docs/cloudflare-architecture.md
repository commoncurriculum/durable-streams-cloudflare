# Cloudflare Durable Streams POC Architecture

## Overview
The Cloudflare POC is a single-worker deployment that routes requests to a **Durable Object (DO) per stream**. The DO is the sequencer for all writes and serves live reads. **DO SQLite** stores the hot log and metadata. **R2** stores immutable cold segments. Real-time delivery uses an **internal WebSocket bridge** between the edge worker and DO, enabling DO hibernation between writes for minimal duration billing.

## Request Flow
1. **Worker** (`src/http/worker.ts`) validates auth (optional), applies CORS, normalizes cache keys, and routes `/v1/stream/<stream-id>` to the stream DO.
2. For **SSE live reads**, the edge worker opens an **internal WebSocket** to the DO and bridges WebSocket messages to SSE events for the client. The DO can hibernate between writes since only hibernatable WebSocket connections remain.
3. **Durable Object** (`src/http/durable_object.ts`) wires storage, protocol helpers, and live fan-out (WebSocket broadcast, SSE, long-poll). Implements the Hibernation API (`webSocketMessage`, `webSocketClose`, `webSocketError`) for internal WebSocket connections.
4. **Read path** (`src/stream/read/path.ts`) encapsulates hot/R2 reads + coalescing.
5. **Storage** (`src/storage/queries.ts`) handles metadata and append/read queries against DO SQLite.
6. **Cold storage** (`src/storage/segments.ts`) writes length-prefixed R2 segments on rotation.

## Key Modules
- `src/http/*`:
  - `worker.ts` edge entry point (auth, cache, routing to DO).
  - `create_worker.ts` edge worker factory — auth, CORS, edge caching, SSE-via-WebSocket bridge.
  - `durable_object.ts` StreamDO class (concurrency, context, Hibernation API handlers, debug actions).
  - `router.ts` dispatches HTTP methods + StreamContext types.
  - `handlers/read.ts` handles `GET`/`HEAD` (offset reads) + internal WebSocket upgrade (`?live=ws-internal`).
  - `handlers/realtime.ts` handles long-poll, SSE, and internal WebSocket connections (LongPollQueue, SseState, WsAttachment, broadcast for all transports).
  - `handlers/write.ts` handles `PUT`/`POST`/`DELETE` + broadcasts to WebSocket, SSE, and long-poll clients.
- `src/stream/*`:
  - `create/*` PUT parse/validate/execute pipeline.
  - `append/*` POST parse/validate/execute pipeline.
  - `read/path.ts` hot log reads, R2 segment reads, and read coalescing.
  - `read/from_offset.ts`, `read/from_messages.ts`, `read/result.ts` read helpers.
  - `producer.ts` handles producer fencing and idempotency.
  - `rotate.ts` flushes hot ops into R2 segments and advances `read_seq`.
  - `offsets.ts` offset parsing/validation and `Stream-Next-Offset` encoding helpers.
  - `close.ts` handles close-only semantics.
  - `content_strategy.ts` JSON vs binary serialization strategy.
  - `shared.ts` shared validation (Content-Length, body size).
- `src/storage/*`:
  - `queries.ts` implements hot storage (DoSqliteStorage).
  - `types.ts` StreamStorage interface + types.
  - `segments.ts` handles R2 key encoding + framing.
- `src/protocol/*`:
  - `timing.ts` optional `Server-Timing` instrumentation for edge + DO profiling.
  - Header/offset/cursor/JSON/limits helpers.

## Data Model (per-stream DO SQLite)
- **stream_meta**: metadata (content type, tail offset, TTL/expiry, closed state).
- **ops**: append log (offset, payload, seq).
- **producers**: producer id/epoch/seq tracking + last updated.
- **segments**: R2 segment records (start/end offsets + read_seq + key).

## Cold Storage / Rotation
The DO compacts the hot tail into length-prefixed **R2 segments** once segment thresholds are hit or on close, then increments `read_seq` and starts a new segment. Catch-up reads prefer R2 segments when available and fall back to the hot log only for the current segment.

## Real-Time Delivery (Internal WebSocket Bridge)

SSE connections from clients are served via an **internal WebSocket bridge** between the edge worker and the DO:

```
Client ←─ SSE ─── Edge Worker ←─ WebSocket (Hibernation API) ─── StreamDO
                  (CPU-time billing,         │
                   idle = free)              │
                                      write arrives → DO wakes
                                             │
                                      sends WS msg to edge → DO sleeps
                                             │
                                      edge writes SSE event to client
```

1. Client requests `?live=sse` — the edge worker opens an internal WebSocket to the DO (`?live=ws-internal`).
2. The DO creates a `WebSocketPair`, accepts the server side via the Hibernation API (`this.ctx.acceptWebSocket()`), sends catch-up data as WebSocket messages, and returns the client side.
3. The edge worker bridges WebSocket messages to SSE events on a `TransformStream`.
4. On writes, the DO broadcasts to all connected WebSockets via `this.ctx.getWebSockets()`, then returns to hibernation.

**Why:** The Hibernation API allows the DO to sleep between writes while holding WebSocket connections. SSE holds an open HTTP response which prevents hibernation. The bridge keeps SSE as the client-facing protocol while enabling DO hibernation for minimal duration billing.

**Message format** (DO → edge, JSON text frames):
- Data: `{ "type": "data", "payload": "...", "encoding": "base64" }` (encoding omitted for text)
- Control: `{ "type": "control", "streamNextOffset": "...", "upToDate": true, "streamClosed": false, "streamCursor": "..." }`

## Registry Stream
The worker emits create/delete events to a system stream (`__registry__`) for clients that need discovery or monitoring.
