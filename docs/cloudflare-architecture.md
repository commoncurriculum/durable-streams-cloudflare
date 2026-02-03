# Cloudflare Durable Streams POC Architecture

## Overview
The Cloudflare POC is a single-worker deployment that routes requests to a
Durable Object (DO) per stream. The DO is the sequencer for all writes and
serves live reads, while D1 (SQLite) stores the hot log and metadata. R2 is
used for cold segments with compaction on writes/close.

## Request Flow
1. **Worker** (`src/worker.ts`) validates auth (optional), applies CORS, and
   routes `/v1/stream/<stream-id>` to the stream DO.
2. **Durable Object** (`src/stream_do.ts`) wires a storage implementation,
   protocol helpers, and live fan-out (SSE/long-poll).
3. **Storage** (`src/storage/d1.ts`) handles metadata and append/read queries
   against D1. Cold segments are stored in R2 with a D1 index.

## Key Modules
- `src/http/*`:
  - `router.ts` dispatches HTTP methods.
  - `handlers/catchup.ts` handles `GET`/`HEAD` (offset reads).
  - `handlers/realtime.ts` handles long-poll + SSE.
  - `handlers/mutation.ts` handles `PUT`/`POST`/`DELETE`.
- `src/engine/*`:
  - `stream.ts` implements protocol semantics (append/read/headers).
  - `producer.ts` handles producer fencing and idempotency.
  - `close.ts` handles close-only semantics.
- `src/storage/*`:
  - `storage.ts` defines the storage interface.
  - `d1.ts` implements hot storage.
  - `segments.ts` handles R2 key encoding + framing.
- `src/protocol/*`:
  - Header/offset/cursor/JSON/limits helpers.
- `src/live/*`:
  - `long_poll.ts` manages wait queues.
  - `sse.ts` formats SSE data/control events.

## Data Model (D1)
- **streams**: metadata (content type, tail offset, TTL/expiry, closed state).
- **ops**: append log (stream id, offset, payload, seq).
- **producers**: producer id/epoch/seq tracking + last updated.
- **snapshots**: R2 segment records (start/end offsets + key).

## Live Modes
- **Long-poll**: waits up to `LONG_POLL_TIMEOUT_MS` for new data, then returns
  204 or 200 with new content.
- **SSE**: streams data and control events, using `Stream-SSE-Data-Encoding`
  for binary payloads.

## Cold Storage / Compaction
The DO compacts older ops into length-prefixed R2 segments, records segment
ranges in D1, and keeps a hot tail in D1 for low-latency reads. On close, the
tail is flushed to R2. Catch-up reads prefer R2 segments when available and
fall back to D1 if a segment is missing or truncated.

## Registry Stream
The worker emits create/delete events to a system stream (`__registry__`) for
clients that need discovery or monitoring.
