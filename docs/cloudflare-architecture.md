# Cloudflare Durable Streams POC Architecture

## Overview
The Cloudflare POC is a single-worker deployment that routes requests to a **Durable Object (DO) per stream**. The DO is the sequencer for all writes and serves live reads. **DO SQLite** stores the hot log and metadata. **R2** stores immutable cold segments. An **optional D1 admin index** provides a global listing of segments for cleanup/ops only.

## Request Flow
1. **Worker** (`src/worker.ts`) validates auth (optional), applies CORS, normalizes cache keys, and routes `/v1/stream/<stream-id>` to the stream DO.
2. **Durable Object** (`src/stream_do.ts`) wires storage, protocol helpers, and live fan-out (SSE/long-poll).
3. **Read path** (`src/do/read_path.ts`) encapsulates hot/R2 reads + coalescing.
4. **Storage** (`src/storage/do_sqlite.ts`) handles metadata and append/read queries against DO SQLite.
5. **Cold storage** (`src/storage/segments.ts`) writes length-prefixed R2 segments on rotation.

## Key Modules
- `src/http/*`:
  - `router.ts` dispatches HTTP methods.
  - `handlers/catchup.ts` handles `GET`/`HEAD` (offset reads).
  - `handlers/realtime.ts` handles long-poll + SSE.
  - `handlers/mutation.ts` handles `PUT`/`POST`/`DELETE`.
- `src/do/read_path.ts`:
  - Hot log reads, R2 segment reads, and read coalescing.
- `src/do/segment_rotation.ts`:
  - Flushes hot ops into R2 segments and advances `read_seq`.
- `src/do/offsets.ts`:
  - Offset parsing/validation and `Stream-Next-Offset` encoding helpers.
- `src/do/admin_index.ts`:
  - Optional D1 admin index writes for segment inventory.
- `src/protocol/timing.ts`:
  - Optional `Server-Timing` instrumentation for edge + DO profiling.
- `src/engine/*`:
  - `stream.ts` implements protocol semantics (append/read/headers).
  - `producer.ts` handles producer fencing and idempotency.
  - `close.ts` handles close-only semantics.
- `src/storage/*`:
  - `do_sqlite.ts` implements hot storage.
  - `segments.ts` handles R2 key encoding + framing.
- `src/protocol/*`:
  - Header/offset/cursor/JSON/limits helpers.
- `src/live/*`:
  - `long_poll.ts` manages wait queues.
  - `sse.ts` formats SSE data/control events.

## Data Model (per-stream DO SQLite)
- **stream_meta**: metadata (content type, tail offset, TTL/expiry, closed state).
- **ops**: append log (offset, payload, seq).
- **producers**: producer id/epoch/seq tracking + last updated.
- **segments**: R2 segment records (start/end offsets + read_seq + key).

## Cold Storage / Rotation
The DO compacts the hot tail into length-prefixed **R2 segments** once segment thresholds are hit or on close, then increments `read_seq` and starts a new segment. Catch-up reads prefer R2 segments when available and fall back to the hot log only for the current segment.

## Admin Index (Optional)
A small D1 table `segments_admin` can be populated asynchronously to provide a global listing of segments for cleanup and ops. It is never on the ACK path.

## Registry Stream
The worker emits create/delete events to a system stream (`__registry__`) for clients that need discovery or monitoring.
