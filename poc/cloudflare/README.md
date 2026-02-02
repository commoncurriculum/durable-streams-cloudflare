# Durable Streams Cloudflare POC (Worker + DO + D1)

This is a Cloudflare-only proof of concept for the Durable Streams protocol with **low-latency, consistent writes** using a Durable Object as the sequencer and **D1 (SQLite)** as the hot log.

## What This POC Includes
- Worker router with optional bearer token auth.
- Durable Object per stream for ordering and live fan-out.
- D1 schema for stream metadata, ops log, and producer state.
- Protocol behaviors for PUT/POST/GET/HEAD/DELETE, long-poll, and SSE.
- JSON mode support (flatten arrays, validate JSON, return arrays on GET).
- Optional R2 snapshot on stream close (cold storage).

## What It Does Not Include (Yet)
- TTL/Expires-At enforcement.
- R2 compaction/snapshots.
- Global stream listing/search.
- Full conformance test coverage.

## Setup (high level)
1. Create a D1 database and update `wrangler.toml` with its ID.
2. Apply migrations in `migrations/` (both 0001 and 0002).
3. Deploy with `wrangler dev` or `wrangler deploy`.

## Conformance
Run the server conformance suite against the local worker:
```bash
npm run conformance
```

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
curl "http://localhost:8787/v1/stream/doc-123?offset=0000000000000000&live=long-poll"
```

SSE:
```bash
curl -N "http://localhost:8787/v1/stream/doc-123?offset=0000000000000000&live=sse"
```

## Notes on Offsets
- Offsets are opaque, lexicographically sortable strings.
- This POC uses fixed-width hex encoding of a monotonic integer.
- JSON streams increment offsets by **message count**; non-JSON streams increment by **byte length**.

## Durability and Latency
- Writes are ACKed only after a D1 transaction commits.
- This is the low-latency, strongly consistent path.
- R2 is intended only for cold storage in a future phase.
  - This POC writes a snapshot to R2 when a stream is closed.

## Files
- `wrangler.toml`
- `migrations/0001_init.sql`
- `src/worker.ts`
- `src/stream_do.ts`
