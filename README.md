# durable-streams

Cloudflare-first **Durable Streams** server: a production‑ready implementation
of the Durable Streams HTTP protocol with **low‑latency writes**, **consistent
ordering**, and **CDN‑compatible catch‑up reads**. It uses a **Durable Object
per stream** as the sequencer, **SQLite in DO storage** as the hot log, and **R2
segments** for immutable cold storage. An **optional D1 admin index** provides a
global segment listing for cleanup/ops.

If you need **real‑time streams with strong ordering guarantees** and **fast
catch‑up**, this is the drop‑in server.

## What You Can Deploy Today
- **Worker + DO** for consistent ordering, append idempotency, and fan‑out.
- **HTTP protocol**: PUT/POST/GET/HEAD/DELETE, long‑poll, SSE.
- **CDN‑aware caching** with cache mode controls.
- **TTL/Expires‑At** enforcement for streams.
- **Conformance‑tested** against the public test suite.

## How It Works (ASCII Diagrams)

### Write Path
```
Client
  |
  |  POST /v1/stream/<id>
  v
Worker (auth + cache mode)
  |
  v
Stream DO (SQLite hot log)
  |
  +--> Optional rotation --> R2 (cold segment, immutable)
  |
  +--> SSE/long‑poll wakeups
```

### Read Path (Catch‑up)
```
Client GET offset=...
  |
  v
Worker (auth + cache mode)
  |
  v
Stream DO
  | \
  |  \-- hot log (SQLite) if offset in tail
  |
  \---- cold segment (R2) if offset in rotated segment
```

### Cache Mode (Auth‑Agnostic)
```
Client (Authorization)
  |
  v
Worker verifies auth
  |
  +--> X-Cache-Mode: shared  -> CDN cacheable
  |
  \--> X-Cache-Mode: private -> Cache-Control: private, no-store
```

## Quick Start (Local)
```bash
cd packages/durable-stream-server
pnpm install
pnpm run dev
```

Run conformance (requires `pnpm run dev` in another shell):
```bash
cd packages/durable-stream-server
pnpm run conformance
```

## Deploy (Cloudflare)
1. Create an **R2 bucket** (required).
2. (Optional) Create a **D1 database** for the admin index.
3. Update `packages/durable-stream-server/wrangler.toml` with ids.
4. (Optional) Apply admin migrations:
   ```bash
   pnpm -C packages/durable-stream-server exec wrangler d1 migrations apply durable_streams_admin
   ```
5. Deploy:
   ```bash
   pnpm -C packages/durable-stream-server exec wrangler deploy
   ```

## Example Usage
```bash
# Create a stream
curl -X PUT -H 'Content-Type: application/json' \
  http://localhost:8787/v1/stream/doc-123

# Append JSON
curl -X POST -H 'Content-Type: application/json' \
  --data '{"op":"insert","text":"hello"}' \
  http://localhost:8787/v1/stream/doc-123

# Catch-up read
curl "http://localhost:8787/v1/stream/doc-123?offset=0000000000000000_0000000000000000"

# Long-poll
curl "http://localhost:8787/v1/stream/doc-123?offset=0000000000000000_0000000000000000&live=long-poll"

# SSE
curl -N "http://localhost:8787/v1/stream/doc-123?offset=0000000000000000_0000000000000000&live=sse"
```

## Why This Isn’t “Just a DO”
Durable Objects provide **single‑threaded state + storage**, but they do **not**
implement:
- The Durable Streams HTTP protocol (offsets, cursors, headers, TTL/expiry).
- Producer idempotency and sequencing (epoch/seq enforcement).
- Catch‑up semantics + long‑poll + SSE.
- CDN‑aware caching behavior for live polling.
- Cold‑segment rotation and R2 read‑seq encoding.
- Conformance guarantees.

This server layers the **Durable Streams protocol + storage model** on top of
Cloudflare’s DOs.

## Repo Layout
- `packages/durable-stream-server/` — Cloudflare Worker + Durable Object + D1 + R2 implementation.
- `docs/cloudflare-refactor-plan.md` — Refactor plan and progress notes for the Cloudflare server.
- `docs/cloudflare-architecture.md` — Module and data-flow overview for the Cloudflare server.

## More Details
See `packages/durable-stream-server/README.md` for implementation specifics,
limitations, and additional operational notes.
