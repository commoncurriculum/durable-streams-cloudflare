# Durable Streams Cloudflare Server (Worker + DO + R2)

Cloudflare-only implementation of the Durable Streams protocol with **low-latency, consistent writes** using a Durable Object as the sequencer and **SQLite in DO storage** as the hot log. R2 stores immutable cold segments.

## What This Server Includes
- Worker router with optional bearer token auth.
- Durable Object per stream for ordering and live fan-out.
- DO SQLite schema for stream metadata, ops log, producer state, and segment index.
- Protocol behaviors for PUT/POST/GET/HEAD/DELETE, long-poll, and SSE.
- JSON mode support (flatten arrays, validate JSON, return arrays on GET).
- TTL/Expires-At enforcement.
- R2 segments for cold storage (length-prefixed segment format).

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

This server uses a DO as the sequencer, then layers the **Durable Streams
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
2. Run the worker locally (uses local R2 via Miniflare; DO SQLite is auto-initialized):
   ```bash
   pnpm run dev
   ```

## Deploy to Cloudflare

### 1. Login to Cloudflare

```bash
pnpx wrangler login
```

### 2. Create Resources

```bash
# Create R2 bucket for cold segment storage
pnpx wrangler r2 bucket create durable-streams
```

The Analytics Engine dataset is created automatically on first deploy.

### 3. Deploy Worker

```bash
pnpx wrangler deploy
```

## Authentication

Out of the box, the default worker ships with bearer token auth for mutations and JWT session auth for reads. But the core library is **auth-agnostic** — you can use the built-in strategies, write your own, or disable auth entirely.

### Default: No Auth

`createStreamWorker()` with no config allows all requests (spec-compliant):

```typescript
import { createStreamWorker, StreamDO } from "durable-streams-core";

export default createStreamWorker();
export { StreamDO };
```

### Built-in Strategies

The package ships two opt-in auth strategies:

```typescript
import { createStreamWorker, bearerTokenAuth, jwtSessionAuth, StreamDO } from "durable-streams-core";

export default createStreamWorker({
  authorizeMutation: bearerTokenAuth(),
  authorizeRead: jwtSessionAuth(),
});
export { StreamDO };
```

- **`bearerTokenAuth()`** — Checks `env.AUTH_TOKEN` for mutations (PUT/POST/DELETE). If `AUTH_TOKEN` is not set, all mutations are allowed. Clients must include `Authorization: Bearer <token>`.
- **`jwtSessionAuth()`** — Validates an HS256 JWT for reads (GET/HEAD) using `env.READ_JWT_SECRET`. The JWT payload must contain `session_id` and `exp` claims. The session ID is scoped to the stream: requests for `session:{id}` require a JWT with matching `session_id`. If `READ_JWT_SECRET` is not set, all reads are allowed.

Set secrets via wrangler:
```bash
pnpx wrangler secret put AUTH_TOKEN
pnpx wrangler secret put READ_JWT_SECRET
```

### Custom Auth

Write your own auth callbacks with the `AuthorizeMutation` and `AuthorizeRead` signatures:

```typescript
import { createStreamWorker, StreamDO } from "durable-streams-core";
import type { BaseEnv, AuthResult } from "durable-streams-core";

type MyEnv = BaseEnv & { API_KEYS: KVNamespace };

export default createStreamWorker<MyEnv>({
  authorizeMutation: async (request, streamId, env, timing) => {
    const key = request.headers.get("X-API-Key");
    if (!key) return { ok: false, response: new Response("unauthorized", { status: 401 }) };
    const valid = await env.API_KEYS.get(key);
    if (!valid) return { ok: false, response: new Response("forbidden", { status: 403 }) };
    return { ok: true };
  },
});
export { StreamDO };
```

Both callbacks receive `(request, streamId, env, timing)` and return `AuthResult | Promise<AuthResult>`:
- `{ ok: true }` — allow the request
- `{ ok: false, response: Response }` — deny with the given response (CORS headers added automatically)

`AuthorizeRead` returns `{ ok: true, sessionId: string }` on success (the session ID is forwarded to the DO via `X-Session-Id` header).

### Using as a Library

To use durable-streams in your own worker project:

1. Install the package and add it to your `wrangler.toml`:
   ```toml
   [[durable_objects.bindings]]
   name = "STREAMS"
   class_name = "StreamDO"
   ```

2. Import and compose in your worker entry:
   ```typescript
   import { createStreamWorker, StreamDO } from "durable-streams-core";
   export default createStreamWorker({ /* your auth config */ });
   export { StreamDO };
   ```

### Environment Variables

| Variable | Used by | Description |
|---|---|---|
| `AUTH_TOKEN` | `bearerTokenAuth()` | Bearer token for mutation auth |
| `READ_JWT_SECRET` | `jwtSessionAuth()` | HS256 secret for JWT read auth |

## Conformance
Run the server conformance suite against the local worker:
```bash
pnpm run conformance
```
Notes:
- If `CONFORMANCE_TEST_URL` is not set, the test runner will start a local worker automatically.
- Set `CONFORMANCE_TEST_URL` to target an existing server.

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
  - `PERF_LONGPOLL_TIMEOUT=1` to include a single long‑poll timeout measurement.

## Debug Timing
Add `X-Debug-Timing: 1` on a request (or set `DEBUG_TIMING=1` in the Worker env)
to emit `Server-Timing` headers for edge + DO timings.

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
- The server accepts sentinel inputs `offset=-1` (stream start) and `offset=now` (current tail),
  but never emits those values as real offsets.

## Durability and Latency
- Writes are ACKed only after a DO SQLite transaction commits.
- R2 stores cold segments; DO SQLite keeps the hot tail + segment index.
- Segment objects use length-prefixed message framing (Caddy parity).
- Segment keys use base64url-encoded stream ids for safe paths.
- Catch-up reads prefer R2 segments when present.
- Segment rotation runs opportunistically on writes and flushes the tail on close.

## CDN Auth + Cache
- The Worker enforces auth, then decides **cache mode** and forwards it via
  `X-Cache-Mode` (`shared` or `private`).
- `CACHE_MODE=shared|private` can force the mode; default is **private**.
- The edge cache is only used for `GET`/`HEAD` requests without `If-None-Match`.
- Cacheability is controlled by `Cache-Control` headers set by the DO.

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
- `src/http/worker.ts` — Default worker composition (bearerTokenAuth + jwtSessionAuth)
- `src/http/create_worker.ts` — `createStreamWorker()` factory (CORS, caching, DO routing)
- `src/http/auth.ts` — Auth types, JWT helpers, built-in strategies
- `src/http/durable_object.ts` — StreamDO class (concurrency, context, debug actions)
- `src/http/router.ts` — Method dispatch + StreamContext/CacheMode types
- `src/http/hono.ts` — Hono app factory for internal DO routes
- `src/http/handlers/read.ts` — GET/HEAD handlers (catch-up reads)
- `src/http/handlers/write.ts` — PUT/POST/DELETE handlers (mutations)
- `src/http/handlers/realtime.ts` — Long-poll + SSE (LongPollQueue, SseState, broadcast)
- `src/stream/create/*` — PUT parse/validate/execute pipeline
- `src/stream/append/*` — POST parse/validate/execute pipeline
- `src/stream/read/*` — ReadPath, offset resolution, segment reads
- `src/stream/producer.ts` — Producer epoch/seq deduplication
- `src/stream/rotate.ts` — Segment rotation to R2
- `src/stream/offsets.ts` — Stream offset encoding/resolution
- `src/stream/shared.ts` — Shared validation (Content-Length, body size)
- `src/stream/close.ts` — Close-only semantics
- `src/storage/queries.ts` — DoSqliteStorage implementation
- `src/storage/types.ts` — StreamStorage interface + types
- `src/storage/segments.ts` — R2 segment encoding/decoding
- `src/protocol/*` — Headers, offsets, cursor, encoding, errors, timing, limits
- `test/implementation/*`
- `test/performance/*`
