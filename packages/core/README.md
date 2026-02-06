# @durable-streams-cloudflare/core

Cloudflare Workers + Durable Objects implementation of the [Durable Streams](https://github.com/electric-sql/durable-streams) HTTP protocol. A Durable Object per stream acts as the sequencer, with SQLite in DO storage as the hot log and R2 for immutable cold segments. Conformance-tested against the official test suite.

This is a **library** — you import `createStreamWorker()`, pass your auth config, and deploy as your own Cloudflare Worker. Your worker file is ~5 lines.

## Features

- **Durable Object per stream** — single-threaded sequencer with strong ordering
- **SQLite hot log** — low-latency writes via DO transactional storage
- **R2 cold segments** — automatic rotation of historical data to immutable R2 objects
- **CDN-aware caching** — `shared` and `private` cache modes, edge cache integration
- **Long-poll + SSE** — real-time delivery with catch-up reads
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
```

### 3. Deploy

```bash
npx wrangler r2 bucket create durable-streams
npx wrangler deploy
```

### 4. Try It

```bash
URL=https://durable-streams.<your-subdomain>.workers.dev

# Create a stream
curl -X PUT -H 'Content-Type: application/json' $URL/v1/stream/my-stream

# Append a message
curl -X POST -H 'Content-Type: application/json' \
  -d '{"op":"insert","text":"hello"}' \
  $URL/v1/stream/my-stream

# Catch-up read
curl "$URL/v1/stream/my-stream?offset=0000000000000000_0000000000000000"

# Long-poll (blocks until new data)
curl "$URL/v1/stream/my-stream?offset=0000000000000000_0000000000000000&live=long-poll"

# SSE (streaming)
curl -N "$URL/v1/stream/my-stream?offset=0000000000000000_0000000000000000&live=sse"
```

## Authentication

### No Auth

`createStreamWorker()` with no config allows all requests:

```ts
import { createStreamWorker, StreamDO } from "@durable-streams-cloudflare/core";

export default createStreamWorker();
export { StreamDO };
```

### Built-in Strategies

```ts
import {
  createStreamWorker, StreamDO,
  bearerTokenAuth, jwtStreamAuth,
} from "@durable-streams-cloudflare/core";

export default createStreamWorker({
  authorizeMutation: bearerTokenAuth(),
  authorizeRead: jwtStreamAuth(),
});
export { StreamDO };
```

**`bearerTokenAuth()`** — Checks `env.AUTH_TOKEN` for mutations (PUT/POST/DELETE). If `AUTH_TOKEN` is not set, all mutations are allowed. Clients send `Authorization: Bearer <token>`.

**`jwtStreamAuth()`** — Validates an HS256 JWT for reads (GET/HEAD) using `env.READ_JWT_SECRET`. The JWT payload must contain `stream_id` and `exp` claims. The `stream_id` must match the requested stream ID. If `READ_JWT_SECRET` is not set, all reads are allowed.

Set secrets:

```bash
npx wrangler secret put AUTH_TOKEN
npx wrangler secret put READ_JWT_SECRET
```

### Custom Auth

Write your own callbacks with the `AuthorizeMutation` and `AuthorizeRead` signatures:

```ts
import { createStreamWorker, StreamDO } from "@durable-streams-cloudflare/core";
import type { BaseEnv, AuthResult } from "@durable-streams-cloudflare/core";

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

**Type signatures:**

```ts
type AuthorizeMutation<E> = (
  request: Request, streamId: string, env: E, timing: Timing | null,
) => AuthResult | Promise<AuthResult>;

type AuthorizeRead<E> = (
  request: Request, streamId: string, env: E, timing: Timing | null,
) => ReadAuthResult | Promise<ReadAuthResult>;

type AuthResult = { ok: true } | { ok: false; response: Response };
type ReadAuthResult = { ok: true; streamId: string } | { ok: false; response: Response };
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
| `AUTH_TOKEN` | *(none)* | Bearer token for mutation auth (used by `bearerTokenAuth()`) |
| `READ_JWT_SECRET` | *(none)* | HS256 secret for JWT read auth (used by `jwtStreamAuth()`) |
| `ADMIN_TOKEN` | *(none)* | Bearer token for admin introspection endpoint |
| `CACHE_MODE` | `private` | Cache mode: `shared` (CDN cacheable) or `private` |
| `DEBUG_TIMING` | `0` | Set to `1` to emit `Server-Timing` headers |
| `SEGMENT_MAX_MESSAGES` | `1000` | Max messages per R2 segment before rotation |
| `SEGMENT_MAX_BYTES` | `4194304` | Max bytes per R2 segment before rotation |

### Wrangler Bindings

| Binding | Type | Description |
|---------|------|-------------|
| `STREAMS` | Durable Object | StreamDO namespace (required) |
| `R2` | R2 Bucket | Cold segment storage (required) |
| `METRICS` | Analytics Engine | Stream operation metrics (optional) |

## Architecture

```
Write Path
  Client ──POST──> Worker (auth, cache mode)
                     │
                     v
                   StreamDO
                     │
                   SQLite hot log (transactional append)
                     │
                     └──> R2 rotation (when segment full)

Read Path
  Client ──GET───> Worker (auth, cache mode)
                     │
                     ├──> Edge cache hit? → return cached
                     │
                     v
                   StreamDO
                     ├── hot log (SQLite) → recent messages
                     └── cold segment (R2) → historical messages
                                              │
                                              v
                                           Edge cache (if shared mode)
```

## See Also

- [`@durable-streams-cloudflare/subscription`](../subscription/README.md) — pub/sub fan-out layer
- [Durable Streams protocol](https://github.com/electric-sql/durable-streams) — upstream spec and test suite

## License

MIT
