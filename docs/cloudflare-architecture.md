# Cloudflare Durable Streams POC Architecture

## Overview
The Cloudflare POC is a single-worker deployment that routes requests to a **Durable Object (DO) per stream**. The DO is the sequencer for all writes and serves live reads. **DO SQLite** stores the hot log and metadata. **R2** stores immutable cold segments.

## Request Flow
1. **Worker** (`src/http/worker.ts`) validates auth (optional), applies CORS, normalizes cache keys, and routes `/v1/stream/<stream-id>` to the stream DO.
2. **Durable Object** (`src/http/durable_object.ts`) wires storage, protocol helpers, and live fan-out (SSE/long-poll).
3. **Read path** (`src/stream/read/path.ts`) encapsulates hot/R2 reads + coalescing.
4. **Storage** (`src/storage/queries.ts`) handles metadata and append/read queries against DO SQLite.
5. **Cold storage** (`src/storage/segments.ts`) writes length-prefixed R2 segments on rotation.

## Key Modules
- `src/http/*`:
  - `worker.ts` edge entry point (auth, cache, routing to DO).
  - `durable_object.ts` StreamDO class (concurrency, context, debug actions).
  - `router.ts` dispatches HTTP methods + StreamContext/CacheMode types.
  - `hono.ts` Hono app factory for internal DO routes.
  - `handlers/read.ts` handles `GET`/`HEAD` (offset reads).
  - `handlers/realtime.ts` handles long-poll + SSE (LongPollQueue, SseState, broadcast).
  - `handlers/write.ts` handles `PUT`/`POST`/`DELETE`.
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

## Registry Stream
The worker emits create/delete events to a system stream (`__registry__`) for clients that need discovery or monitoring.
