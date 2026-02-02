# Cloudflare-Only Durable Streams (Low-Latency + Consistent)

This is a concrete design for implementing the Durable Streams protocol entirely on Cloudflare with **consistent, low-latency writes** suitable for a real-time text editor.

## Summary
- **Worker** handles auth, routing, and cache policy.
- **Durable Object (one per stream/document)** provides strict ordering, live fan-out, and protocol behavior.
- **D1 (SQLite)** is the **durable hot log**. We ACK only after a D1 transaction commits.
- **R2** is **optional cold storage** for snapshots and historical compaction, never on the ACK path.

This keeps per-keystroke latency low while preserving strong consistency.

## Core Principle
Object storage is **not** in the ACK path. The ACK path is **Durable Object + D1**. R2 is background-only.

## Architecture
```
Client
  -> Worker (auth, routing, cache policy)
       -> Durable Object (per stream)
            -> D1 (hot log, metadata, producer state)
            -> R2 (optional cold storage, snapshots)
```

## Durable Object Responsibilities
- Validate requests and protocol headers.
- Assign offsets and enforce ordering.
- Enforce idempotent producers (`Producer-Id/Epoch/Seq`).
- Serve catch-up reads, long-poll, and SSE from the stream log.
- Maintain in-memory waiters for live reads.

## D1 Schema (Hot Log + Metadata)
```sql
CREATE TABLE streams (
  stream_id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  tail_offset INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE producers (
  stream_id TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  PRIMARY KEY (stream_id, producer_id)
);

CREATE TABLE ops (
  stream_id TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  stream_seq TEXT,
  producer_id TEXT,
  producer_epoch INTEGER,
  producer_seq INTEGER,
  body BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (stream_id, start_offset)
);

CREATE INDEX ops_stream_offset ON ops(stream_id, start_offset);
```

## Offset Encoding
- Internally store offsets as **monotonic integers** in D1.
- Encode for the protocol as fixed-width base32 or hex with zero-padding.
- Must be **lexicographically sortable** and **opaque**.
- Never emit reserved sentinel values `-1` or `now`.

Example encoding:
- Integer `42` -> `000000000000002A` (hex, fixed width)

## Append Flow (POST)
1. Worker routes request to DO instance for the stream.
2. DO validates:
- `Content-Type` required unless close-only.
- `Stream-Closed: true` semantics.
- Producer headers are all-or-none.
- Optional `Stream-Seq` ordering (lexicographic).
3. D1 transaction:
- Lock stream row.
- Reject if closed (409).
- Validate producer epoch/seq.
- Assign `start_offset = tail_offset` and `end_offset`.
- Insert `ops` row.
- Update `streams.tail_offset`.
- Update `producers` row if present.
- Set `streams.closed` if close-only.
4. ACK only after commit:
- `204 No Content`
- `Stream-Next-Offset: <encoded end_offset>`
- Producer headers echoed per protocol.

This gives **durability + strict ordering** without object storage latency.

## Catch-Up Read Flow (GET)
1. Validate offset (`-1`, `now`, or encoded token).
2. Query `ops` by `start_offset >= requested_offset`.
3. Read up to max chunk size.
4. Build response:
- `Stream-Next-Offset`
- `ETag` (must change if stream is closed)
- `Stream-Up-To-Date` when at tail
- `Stream-Closed` when closed and at final offset
- `Cache-Control` per protocol

For `application/json` streams, the body is a JSON array of messages.

## Long-Poll Flow
1. If data is available, return immediately.
2. Otherwise, wait on a DO-held promise until data arrives or timeout.
3. Always return:
- `Stream-Next-Offset`
- `Stream-Cursor` (interval + jitter rules)
- `Stream-Up-To-Date: true` on timeout

If the stream is closed and at tail, return immediately with `204` and `Stream-Closed: true`.

## SSE Flow
- Stream `text/event-stream`.
- Data events carry chunks; control events carry:
- `streamNextOffset`
- `streamCursor` (unless closed)
- `upToDate`
- `streamClosed`

For non-text/json streams, base64 encode and set `stream-sse-data-encoding: base64`.

## Cache Policy (Worker)
- Cache **catch-up GET** only.
- Do **not** cache `live=long-poll` or `live=sse`.
- Use `ETag` and `If-None-Match` for bandwidth savings.
- Use `Stream-Cursor` to avoid cache loops in live modes.

## Optional Cold Storage (R2)
Use R2 only for:
- Snapshots
- Compacted history

Never for ACK path. Writes to R2 happen asynchronously from the DO after batching.

## Consistency Guarantees
- Single-writer DO per stream ensures ordering.
- D1 transaction guarantees atomic append and producer state update.
- Read-your-writes is guaranteed after commit.

## Latency Target (50ms)
Hitting ~50ms end-to-end (server -> client) is possible only when clients are geographically close to the compute and storage path for that document. For global users, design for **per-region** 50ms rather than global 50ms.

Practical implications:
- **Per-document locality**: Pin each document to a primary region and keep the entire write path (Worker -> DO -> D1) within that region.
- **Single round-trip in the hot path**: The ACK path should be exactly one DO -> D1 transaction and no additional cross-region calls.
- **Persistent connections**: Keep SSE connections open to avoid re-handshakes.
- **Micro-batching**: Coalesce keystrokes into 5-20ms batches to reduce per-append overhead without user-visible lag.
- **Optimistic UI**: Render local ops immediately; reconcile on ACK to mask network variance.

## Performance Notes
- < 100 writes/sec per document is realistic with serialized writes.
- Micro-batching 5-20ms can reduce write amplification.
- Catch-up reads are fast and can be cached.

## Implementation Checklist
- Implement DO append/read/long-poll/SSE handlers.
- Implement D1 schema and transaction logic.
- Implement offset encoder/decoder.
- Implement producer idempotency rules.
- Run server conformance tests.

## Risks and Mitigations
- D1 latency spikes: mitigate with batching and backpressure.
- Very hot documents: shard by section or cursor range.
- Long-running SSE: enforce reconnect interval.

## Next Steps
- Build the DO + D1 prototype.
- Run conformance suite against Worker endpoint.
- Load test with editor-like traffic.
