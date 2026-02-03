# Durable Streams Cloudflare POC (Worker + DO + R2)

Cloudflare-only proof of concept for the Durable Streams protocol with **low-latency, consistent writes** using a Durable Object as the sequencer and **SQLite in DO storage** as the hot log. R2 stores immutable cold segments. An **optional D1 admin index** provides a global listing of segments for cleanup/ops.

## What This POC Includes
- Worker router with optional bearer token auth.
- Durable Object per stream for ordering and live fan-out.
- DO SQLite schema for stream metadata, ops log, producer state, and segment index.
- Protocol behaviors for PUT/POST/GET/HEAD/DELETE, long-poll, and SSE.
- JSON mode support (flatten arrays, validate JSON, return arrays on GET).
- TTL/Expires-At enforcement.
- R2 segments for cold storage (length-prefixed segment format).
- Optional D1 admin index for global segment listing.

## What It Does Not Include (Yet)
- Background compaction scheduling (runs opportunistically on writes).
- Multi-tenant auth or per-stream ACLs.
- Range-read indexing for very large segments.

## Why This Isn’t “Just a DO”
Durable Objects give you **single-threaded state + storage**, but they do **not**
provide:
- The Durable Streams HTTP protocol (offsets, cursors, TTL/expiry, headers).
- Producer ordering and idempotency semantics (epoch/seq enforcement).
- Catch-up semantics + long-poll + SSE behavior.
- CDN-aware caching behavior for long-poll responses.
- Cold-storage rotation to R2 segments and read‑seq offset encoding.
- Conformance test compatibility.

This POC uses a DO as the sequencer, then layers the **Durable Streams
protocol + storage model** on top.

## Why the DO Parses R2 Segments (No Raw Byte-Range)
R2 segments are **length‑prefixed message frames**. Offsets are *message index*
for JSON streams and *byte offsets* for non‑JSON streams (not raw R2 byte
positions). The DO must decode the segment to map an offset to the correct
message boundary and chunk limit. The CDN caches the **final HTTP response**
from the worker; it does not interpret offsets itself.

## Setup (local)
1. Install dependencies:
   ```bash
   pnpm install
   ```
2. (Optional) Apply admin D1 migrations locally:
   ```bash
   pnpm exec wrangler d1 migrations apply durable_streams_admin --local
   ```
3. Run the worker locally (uses local R2 via Miniflare; DO SQLite is auto-initialized):
   ```bash
   pnpm run dev
   ```

## Setup (remote)
1. Create an R2 bucket (required).
2. (Optional) Create a D1 database for the admin index.
3. Update `wrangler.toml` with real ids.
4. (Optional) Apply admin migrations:
   ```bash
   pnpm exec wrangler d1 migrations apply durable_streams_admin
   ```
5. Deploy:
   ```bash
   pnpm exec wrangler deploy
   ```

## Conformance
Run the server conformance suite against the local worker:
```bash
pnpm run conformance
```
Note: `pnpm run dev` must be running in another shell.

## Implementation Tests
Run durability/concurrency tests against the local worker:
```bash
pnpm run test:implementation
```
Note: If `IMPLEMENTATION_TEST_URL` is not set, the test runner will start a local
worker automatically. Set `IMPLEMENTATION_TEST_URL` to target an existing server.

## Performance Smoke
Run a local latency smoke check (append/read p50/p95):
```bash
pnpm run perf
```
Notes:
- Uses `PERF_BASE_URL` if set, otherwise spins up a local worker automatically.
- If `PERF_BASE_URL` is set, the test enforces the budget by default.
- Optional env vars:
  - `PERF_ITERATIONS` to change sample count (default 25).
  - `PERF_BUDGET_MS` + `PERF_ENFORCE=1` to override the budget behavior.

## Stream URL
```
/v1/stream/<stream-id>
```

## Example Requests
Create:
```bash
curl -X PUT \
  -H 'Content-Type: application/json' \
  http://localhost:8787/v1/stream/doc-123
```

Append (JSON):
```bash
curl -X POST \
  -H 'Content-Type: application/json' \
  --data '{"op":"insert","text":"hello"}' \
  http://localhost:8787/v1/stream/doc-123
```

Catch-up read:
```bash
curl "http://localhost:8787/v1/stream/doc-123?offset=0000000000000000_0000000000000000"
```

Long-poll:
```bash
curl "http://localhost:8787/v1/stream/doc-123?offset=0000000000000000_0000000000000000&live=long-poll"
```

SSE:
```bash
curl -N "http://localhost:8787/v1/stream/doc-123?offset=0000000000000000_0000000000000000&live=sse"
```

## Notes on Offsets
- Offsets are opaque, lexicographically sortable strings.
- This POC uses fixed-width decimal `readSeq_byteOffset` encoding (Caddy/Node parity).
- `readSeq` increments after a segment is rotated to R2; `byteOffset` resets per segment.
- JSON streams increment offsets by **message count**; non-JSON streams increment by **byte length**.

## Durability and Latency
- Writes are ACKed only after a DO SQLite transaction commits.
- R2 stores cold segments; DO SQLite keeps the hot tail + segment index.
- Segment objects use length-prefixed message framing (Caddy parity).
- Segment keys use base64url-encoded stream ids for safe paths.
- Catch-up reads prefer R2 segments when present.
- Segment rotation runs opportunistically on writes and flushes the tail on close.

## Registry Stream
The worker emits create/delete events to a system stream named `__registry__`.
Events are JSON messages of the form:
```json
{
  "type": "stream",
  "key": "my-stream-id",
  "value": {
    "path": "my-stream-id",
    "contentType": "application/json",
    "createdAt": 1738591200000
  },
  "headers": { "operation": "insert" }
}
```
Delete events omit `value` and set `operation` to `delete`.

## CORS / Browser Headers
The worker exposes these response headers for browser clients:
`Stream-Next-Offset`, `Stream-Cursor`, `Stream-Up-To-Date`, `Stream-Closed`,
`ETag`, `Location`, `Producer-Epoch`, `Producer-Seq`,
`Producer-Expected-Seq`, `Producer-Received-Seq`, `Stream-SSE-Data-Encoding`.

## Files
- `wrangler.toml`
- `migrations/0001_segments_admin.sql`
- `src/worker.ts`
- `src/stream_do.ts`
- `src/engine/*`
- `src/live/*`
- `src/protocol/*`
- `src/storage/*`
- `test/implementation/*`
- `test/performance/*`
