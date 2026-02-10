# @durable-streams-cloudflare/core

Cloudflare Workers + Durable Objects implementation of the [Durable Streams](https://github.com/electric-sql/durable-streams) HTTP protocol. A Durable Object per stream acts as the sequencer, with SQLite in DO storage as the hot log and R2 for immutable cold segments. Conformance-tested against the official test suite.

This is a **library** — you import `createStreamWorker()`, pass your auth config, and deploy as your own Cloudflare Worker. Your worker file is ~5 lines.

## Features

- **Durable Object per stream** — single-threaded sequencer with strong ordering
- **SQLite hot log** — low-latency writes via DO transactional storage
- **R2 cold segments** — automatic rotation of historical data to immutable R2 objects
- **Protocol-correct caching** — Cache-Control headers per Durable Streams spec, external CDN-friendly
- **Long-poll + SSE** — real-time delivery with catch-up reads
- **DO hibernation** — SSE via internal WebSocket bridge lets the DO sleep between writes
- **JSON mode** — array flattening, JSON validation, message-count offsets
- **TTL / Expires-At** — stream-level time-to-live enforcement
- **Idempotent producers** — epoch/seq-based duplicate detection
- **Pluggable auth** — mutation and read auth callbacks, or bring your own
- **Conformance-tested** — passes the official Durable Streams test suite

## Quick Start

### 1. Install

```bash
npm install @durable-streams-cloudflare/core
```

### 2. Create Your Worker

`src/worker.ts`:

```ts
import { createStreamWorker, StreamDO } from "@durable-streams-cloudflare/core";

export default createStreamWorker();
export { StreamDO };
```

`wrangler.toml`:

```toml
name = "durable-streams"
main = "src/worker.ts"
compatibility_date = "2025-02-02"

[durable_objects]
bindings = [{ name = "STREAMS", class_name = "StreamDO" }]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["StreamDO"]

[[r2_buckets]]
binding = "R2"
bucket_name = "durable-streams"

[[analytics_engine_datasets]]
binding = "METRICS"
dataset = "durable_streams_metrics"

# Required for projectJwtAuth()
[[kv_namespaces]]
binding = "REGISTRY"
id = "<your-kv-namespace-id>"
```

### 3. Deploy

```bash
npx wrangler r2 bucket create durable-streams
npx wrangler deploy
```

### 4. Try It

```bash
URL=https://durable-streams.<your-subdomain>.workers.dev

# Create a stream (requires a write-scope JWT)
curl -X PUT -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $JWT" \
  $URL/v1/stream/my-project/my-stream

# Append a message
curl -X POST -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $JWT" \
  -d '{"op":"insert","text":"hello"}' \
  $URL/v1/stream/my-project/my-stream

# Catch-up read (read or write scope)
curl -H "Authorization: Bearer $JWT" \
  "$URL/v1/stream/my-project/my-stream?offset=0000000000000000_0000000000000000"

# Long-poll (blocks until new data)
curl -H "Authorization: Bearer $JWT" \
  "$URL/v1/stream/my-project/my-stream?offset=0000000000000000_0000000000000000&live=long-poll"

# SSE (streaming)
curl -N -H "Authorization: Bearer $JWT" \
  "$URL/v1/stream/my-project/my-stream?offset=0000000000000000_0000000000000000&live=sse"
```

## Authentication

### Per-Project JWT Auth (Default)

The built-in `projectJwtAuth()` uses per-project HMAC-SHA256 signing secrets stored in a `REGISTRY` KV namespace. Each project gets its own signing secret. JWTs are signed with that secret — the secret never goes over the wire.

```ts
import { createStreamWorker, StreamDO, projectJwtAuth } from "@durable-streams-cloudflare/core";

const { authorizeMutation, authorizeRead } = projectJwtAuth();
export default createStreamWorker({ authorizeMutation, authorizeRead });
export { StreamDO };
```

**JWT claims:**

```json
{
  "sub": "my-project",
  "scope": "write",
  "exp": 1738900000,
  "stream_id": "my-stream"
}
```

| Claim | Required | Description |
|-------|----------|-------------|
| `sub` | Yes | Must match the project ID in the URL path |
| `scope` | Yes | `"write"` (read+write) or `"read"` (read-only) |
| `exp` | Yes | Unix timestamp expiry |
| `stream_id` | No | If present, restricts reads to this specific stream |

Create a project and get its signing secret via the admin dashboard or CLI:

```bash
npx durable-streams create-project
```

### Public Streams

Individual streams can be made publicly readable (no auth required) by adding `?public=true` to the stream creation URL:

```bash
curl -X PUT -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $JWT" \
  "$URL/v1/stream/my-project/public-feed?public=true"
```

Public streams are readable without a token. Writes still require auth. The public flag is immutable — to change it, delete and recreate the stream.

### No Auth

`createStreamWorker()` with no config allows all requests:

```ts
import { createStreamWorker, StreamDO } from "@durable-streams-cloudflare/core";

export default createStreamWorker();
export { StreamDO };
```

### Custom Auth

Write your own callbacks with the `AuthorizeMutation` and `AuthorizeRead` signatures:

```ts
import { createStreamWorker, StreamDO } from "@durable-streams-cloudflare/core";
import type { BaseEnv, AuthResult } from "@durable-streams-cloudflare/core";

type MyEnv = BaseEnv & { MY_KEYS: KVNamespace };

export default createStreamWorker<MyEnv>({
  authorizeMutation: async (request, doKey, env, timing) => {
    const key = request.headers.get("X-API-Key");
    if (!key) return { ok: false, response: new Response("unauthorized", { status: 401 }) };
    const valid = await env.MY_KEYS.get(key);
    if (!valid) return { ok: false, response: new Response("forbidden", { status: 403 }) };
    return { ok: true };
  },
});
export { StreamDO };
```

**Type signatures:**

```ts
type AuthorizeMutation<E> = (
  request: Request, doKey: string, env: E, timing: Timing | null,
) => AuthResult | Promise<AuthResult>;

type AuthorizeRead<E> = (
  request: Request, doKey: string, env: E, timing: Timing | null,
) => ReadAuthResult | Promise<ReadAuthResult>;

type AuthResult = { ok: true } | { ok: false; response: Response };
type ReadAuthResult = { ok: true } | { ok: false; response: Response };
```

## API

All endpoints are under `/v1/stream/:id`.

| Method | Description |
|--------|-------------|
| `PUT` | Create a stream (optional body as first message) |
| `POST` | Append a message (or close the stream) |
| `GET` | Read messages — catch-up, long-poll (`?live=long-poll`), or SSE (`?live=sse`) |
| `HEAD` | Get stream metadata headers without body |
| `DELETE` | Delete a stream and all its data |

**Query parameters:** `offset` (start reading from this position), `live` (`long-poll` or `sse`).

See the [Durable Streams protocol spec](https://github.com/electric-sql/durable-streams) for full details on headers, offsets, and producer semantics.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEBUG_TIMING` | `0` | Set to `1` to emit `Server-Timing` headers |
| `SEGMENT_MAX_MESSAGES` | `1000` | Max messages per R2 segment before rotation |
| `SEGMENT_MAX_BYTES` | `4194304` | Max bytes per R2 segment before rotation |

### Wrangler Bindings

| Binding | Type | Description |
|---------|------|-------------|
| `STREAMS` | Durable Object | StreamDO namespace (required) |
| `R2` | R2 Bucket | Cold segment storage (required) |
| `REGISTRY` | KV Namespace | Per-project signing secrets and public stream flags (required when using `projectJwtAuth`) |
| `METRICS` | Analytics Engine | Stream operation metrics (optional) |

## Architecture

```
Writes
  Client ── POST ──> Edge Worker (auth) ──> StreamDO ──> SQLite
                                                │
                                                ├──> broadcast to live readers
                                                └──> R2 rotation (when full)

Catch-Up Reads
  Client ── GET ───> Edge Worker (auth, cache) ──> StreamDO
                                                     ├── SQLite (recent)
                                                     └── R2 (historical)

SSE (Internal WebSocket Bridge)
  Client ←── SSE ──── Edge Worker ←── WebSocket ──── StreamDO
                      (idle = $0)     (Hibernation    (sleeps between
                                       API)            writes)
```

### How SSE Works

SSE uses an internal WebSocket bridge so the Durable Object can hibernate between writes:

1. Client requests `?live=sse` — edge worker opens an internal WebSocket to the DO
2. DO sends catch-up data over the WebSocket, then hibernates
3. When a write arrives, DO wakes, broadcasts to all WebSocket clients, hibernates again
4. Edge worker translates each WebSocket message to an SSE event for the client

The client sees standard SSE (`EventSource` works unchanged). The DO is only billed for the milliseconds it spends processing writes. Edge workers are billed on CPU time — holding an idle SSE stream costs $0.

## See Also

- [`@durable-streams-cloudflare/subscription`](../subscription/README.md) — pub/sub fan-out layer
- [Durable Streams protocol](https://github.com/electric-sql/durable-streams) — upstream spec and test suite

## License

MIT
