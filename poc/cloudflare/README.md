# Durable Streams Cloudflare POC (Worker + DO + D1)

Cloudflare-only proof of concept for the Durable Streams protocol with **low-latency, consistent writes** using a Durable Object as the sequencer and **D1 (SQLite)** as the hot log.

## What This POC Includes
- Worker router with optional bearer token auth.
- Durable Object per stream for ordering and live fan-out.
- D1 schema for stream metadata, ops log, producer state, and snapshot index.
- Protocol behaviors for PUT/POST/GET/HEAD/DELETE, long-poll, and SSE.
- JSON mode support (flatten arrays, validate JSON, return arrays on GET).
- TTL/Expires-At enforcement.
- R2 segments for cold storage (length-prefixed segment format + snapshot index).
- Full server conformance coverage (239/239).

## What It Does Not Include (Yet)
- Background compaction scheduling (runs opportunistically on writes).
- Global stream listing/search.
- Multi-tenant auth or per-stream ACLs.

## Setup (local)
1. Install dependencies:
   ```bash
   pnpm install
   ```
2. Apply migrations (local D1):
   ```bash
   wrangler d1 execute durable_streams_poc --local --file migrations/0001_init.sql
   wrangler d1 execute durable_streams_poc --local --file migrations/0002_expiry_snapshots.sql
   wrangler d1 execute durable_streams_poc --local --file migrations/0003_producer_last_updated.sql
   wrangler d1 execute durable_streams_poc --local --file migrations/0004_closed_by_producer.sql
   ```
3. Run the worker locally (uses local D1 and local R2 via Miniflare):
   ```bash
   pnpm run dev
   ```

## Setup (remote)
1. Create a D1 database and R2 bucket in your Cloudflare account.
2. Update `wrangler.toml` with the real `database_id` and `bucket_name`.
3. Apply migrations (remote D1):
   ```bash
   wrangler d1 execute durable_streams_poc --file migrations/0001_init.sql
   wrangler d1 execute durable_streams_poc --file migrations/0002_expiry_snapshots.sql
   wrangler d1 execute durable_streams_poc --file migrations/0003_producer_last_updated.sql
   wrangler d1 execute durable_streams_poc --file migrations/0004_closed_by_producer.sql
   ```
4. Deploy:
   ```bash
   wrangler deploy
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
curl "http://localhost:8787/v1/stream/doc-123?offset=-1"
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
- `readSeq` is currently `0` for all offsets (reserved for future segment rotation).
- JSON streams increment offsets by **message count**; non-JSON streams increment by **byte length**.

## Durability and Latency
- Writes are ACKed only after a D1 transaction commits.
- This is the low-latency, strongly consistent path.
- R2 stores cold segments; D1 keeps the hot tail + segment index.
- Segment objects use length-prefixed message framing (Caddy parity).
- Segment keys use base64url-encoded stream ids for safe paths.
- Catch-up reads prefer R2 segments when present (fallback to D1 if missing or truncated).
- Compaction runs opportunistically on writes and flushes the tail on close.

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
- `migrations/0001_init.sql`
- `migrations/0002_expiry_snapshots.sql`
- `src/worker.ts`
- `src/stream_do.ts`
- `src/engine/*`
- `src/live/*`
- `src/protocol/*`
- `src/storage/*`
- `test/implementation/*`
- `test/performance/*`
