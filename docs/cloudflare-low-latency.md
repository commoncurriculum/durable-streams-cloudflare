# Cloudflare-Only Durable Streams (Low-Latency + Consistent)

This document describes the Cloudflare-only architecture for Durable Streams with **low-latency, consistent writes** suitable for a real-time text editor.

## Summary
- **Worker** handles auth, routing, and cache policy.
- **Durable Object (one per stream/document)** provides strict ordering, live fan-out, and protocol behavior.
- **DO SQLite** is the **durable hot log**. ACK only after a SQLite commit.
- **R2** is cold storage for immutable segments, never on the ACK path.
- **Optional D1 admin index** provides global listing of segments for cleanup/ops.

## Core Principle
Object storage is **not** in the ACK path. The ACK path is **Durable Object + SQLite**.

## Architecture
```
Client
  -> Worker (auth, routing, cache policy)
       -> Durable Object (per stream)
            -> SQLite (hot log, metadata, producer state)
            -> R2 (cold segments)
            -> D1 (optional admin index)
```

## Durable Object Responsibilities
- Validate requests and protocol headers.
- Assign offsets and enforce ordering.
- Enforce idempotent producers (`Producer-Id/Epoch/Seq`).
- Serve catch-up reads, long-poll, and SSE from the stream log.
- Maintain in-memory waiters for live reads.

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
1. Worker routes request to DO for the stream.
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

## Catch-Up Read Flow (GET)
1. Validate offset token.
2. If offset is in current segment, read from hot log.
3. Else read from R2 segment.
4. Return:
   - `Stream-Next-Offset`
   - `Stream-Up-To-Date` when at tail
   - `Stream-Closed` when closed and at tail

## Long-Poll Flow
- **Shared-cache mode**: responses are cacheable with short TTL (1–2s) to enable CDN collapse.
- **Private-cache mode**: no-store + DO in-flight coalescing.

## Segment Rotation
- Rotate when either limit is hit:
  - `segmentMaxMessages` (default 1000)
  - `segmentMaxBytes` (default 4 MB)
- Write segment to R2, insert segment record, increment `read_seq`, reset segment counters.

## Consistency Guarantees
- Single-writer DO per stream ensures ordering.
- SQLite commit guarantees atomic append and producer state update.
- Read-your-writes is guaranteed after commit.

## Latency Target (50ms)
Hitting ~50ms end-to-end (server -> client) is possible only when clients are geographically close to the compute and storage path for that document. For global users, design for **per-region** 50ms rather than global 50ms.

Practical implications:
- **Per-document locality**: pin each document to a primary region and keep the entire write path (Worker -> DO -> SQLite) within that region.
- **Single round-trip in the hot path**: the ACK path should be exactly one DO SQLite transaction and no additional cross-region calls.
- **Persistent connections**: keep SSE connections open to avoid re-handshakes.
- **Micro-batching**: coalesce keystrokes into 5–20ms batches to reduce per-append overhead.
- **Optimistic UI**: render local ops immediately; reconcile on ACK to mask network variance.
