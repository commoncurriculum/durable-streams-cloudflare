# Low-Latency Durable Streams on Cloudflare

Architecture for Durable Streams with **low-latency, consistent writes** suitable for a real-time text editor.

## Core Principle

Object storage is **not** in the ACK path. The ACK path is **Durable Object + SQLite** — a single transaction, a single region.

## Summary

- **Edge Worker** handles auth, routing, edge caching, and the SSE-via-WebSocket bridge.
- **Durable Object (one per stream)** provides strict ordering, live fan-out, and protocol behavior.
- **DO SQLite** is the durable hot log. ACK only after a SQLite commit.
- **R2** is cold storage for immutable segments — never on the ACK path.
- **Analytics Engine** for optional metrics and observability.

## Architecture

```
Client
  ──> Edge Worker (auth, cache, SSE bridge)
       ──> Durable Object (per stream)
            ──> SQLite (hot log, metadata, producer state)
            ──> R2 (cold segments, off ACK path)
            ──> WebSocket broadcast (live readers, via Hibernation API)
```

## Durable Object Responsibilities

- Validate requests and protocol headers.
- Assign offsets and enforce ordering.
- Enforce idempotent producers (`Producer-Id/Epoch/Seq`).
- Serve catch-up reads and long-poll from the stream log.
- Accept internal WebSocket connections from edge workers (Hibernation API).
- Broadcast new data to all connected WebSocket, SSE, and long-poll clients on writes.

## SQLite Schema (per-stream)

```sql
CREATE TABLE stream_meta (
  stream_id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  tail_offset INTEGER NOT NULL DEFAULT 0,
  read_seq INTEGER NOT NULL DEFAULT 0,
  segment_start INTEGER NOT NULL DEFAULT 0,
  segment_messages INTEGER NOT NULL DEFAULT 0,
  segment_bytes INTEGER NOT NULL DEFAULT 0,
  last_stream_seq TEXT,
  ttl_seconds INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  closed_by_producer_id TEXT,
  closed_by_epoch INTEGER,
  closed_by_seq INTEGER
);

CREATE TABLE producers (
  producer_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  last_offset INTEGER NOT NULL,
  last_updated INTEGER
);

CREATE TABLE ops (
  start_offset INTEGER PRIMARY KEY,
  end_offset INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  stream_seq TEXT,
  producer_id TEXT,
  producer_epoch INTEGER,
  producer_seq INTEGER,
  body BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE segments (
  read_seq INTEGER PRIMARY KEY,
  r2_key TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  size_bytes INTEGER NOT NULL,
  message_count INTEGER NOT NULL
);
```

## Offset Encoding

- Offsets are fixed-width decimal `readSeq_byteOffset`.
- `readSeq` increments when a segment is rotated to R2; `byteOffset` resets per segment.
- JSON streams increment offsets by **message count**; non-JSON streams by **byte length**.

## Append Flow (POST)

1. Edge worker routes request to the stream's DO.
2. DO validates:
   - `Content-Type` required unless close-only.
   - `Stream-Closed: true` semantics.
   - Producer headers all-or-none.
3. SQLite transaction:
   - Reject if closed (409).
   - Validate producer epoch/seq.
   - Assign `start_offset` and `end_offset`.
   - Insert `ops` row.
   - Update `stream_meta` (tail offset, segment counters, producer state).
4. ACK only after commit:
   - `204 No Content`
   - `Stream-Next-Offset` header
5. Broadcast to all connected live readers (WebSocket, SSE, long-poll).

## Catch-Up Read Flow (GET)

1. Validate offset token.
2. If offset is in current segment, read from SQLite hot log.
3. Else read from R2 cold segment.
4. Return:
   - `Stream-Next-Offset`
   - `Stream-Up-To-Date` when at tail
   - `Stream-Closed` when closed and at tail

## Real-Time Delivery

### SSE via Internal WebSocket Bridge

SSE uses an internal WebSocket bridge between the edge worker and the DO:

```
Client ←── SSE ──── Edge Worker ←── WebSocket (Hibernation API) ──── StreamDO
                    (idle = $0)                                       (sleeps between writes)
```

The edge worker opens a WebSocket to the DO (`?live=ws-internal`), then bridges WebSocket messages to SSE events for the client. The DO accepts the connection via the Hibernation API and can sleep between writes — waking only when a POST/PUT/DELETE arrives.

The bridge adds zero latency to live push: when a write arrives, the DO broadcasts to all WebSocket clients before returning to hibernation. The edge worker immediately translates each WebSocket message to an SSE event. The client sees standard SSE — `EventSource` works unchanged.

### Long-Poll

Long-poll requests park at the DO with a timeout. Responses include protocol-correct `Cache-Control: public, max-age=20` headers. DO-level in-flight coalescing and a recent-read cache (100ms, auto-invalidating) deduplicate concurrent requests.

## Segment Rotation

- Rotate when either limit is hit:
  - `segmentMaxMessages` (default 1000)
  - `segmentMaxBytes` (default 4 MB)
- Write segment to R2, insert segment record, increment `read_seq`, reset segment counters.

## Consistency Guarantees

- Single-writer DO per stream ensures ordering.
- SQLite commit guarantees atomic append and producer state update.
- Read-your-writes is guaranteed after commit.

## DO Hibernation and Cost

The internal WebSocket bridge enables DO hibernation between writes. Cloudflare does not bill for DO duration while hibernating. For the DO to hibernate, it needs:

- No active HTTP requests (the POST has returned)
- No timers (no `setTimeout`/`setInterval`)
- No in-progress `fetch()` calls
- Only hibernatable WebSocket connections (accepted via `this.ctx.acceptWebSocket()`)

All four conditions are met after a write handler completes — the DO sleeps immediately.

Edge workers are billed on CPU time, not wall clock. Holding an idle SSE stream and an idle WebSocket connection costs $0. For read-heavy workloads, this reduces DO duration billing by ~99% compared to holding SSE connections directly on the DO.

## Latency Target (50ms)

~50ms end-to-end (server → client) is achievable when clients are geographically close to the DO. For global users, design for **per-region** 50ms rather than global 50ms.

Practical implications:

- **Per-document locality**: pin each document to a primary region. Keep the entire write path (Worker → DO → SQLite) within that region.
- **Single round-trip in the hot path**: the ACK path is exactly one DO SQLite transaction — no cross-region calls.
- **Persistent connections**: the internal WebSocket bridge maintains persistent connections at the edge while the DO sleeps. Clients keep their SSE connection open across hibernation cycles — no re-handshakes.
- **Micro-batching**: coalesce keystrokes into 5–20ms batches to reduce per-append overhead.
- **Optimistic UI**: render local ops immediately; reconcile on ACK to mask network variance.
