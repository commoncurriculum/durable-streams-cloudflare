# @durable-streams-cloudflare/server

Unified Cloudflare Workers + Durable Objects implementation combining **core streaming** ([Durable Streams protocol](https://github.com/electric-sql/durable-streams)) with **pub/sub subscriptions** (fan-out to multiple subscribers).

This package merges the functionality of `@durable-streams-cloudflare/core` and `@durable-streams-cloudflare/subscription` into a single worker with enhanced features powered by Hono.

## Features

### Core Streaming

- **Durable Object per stream** — single-threaded sequencer with strong ordering
- **SQLite hot log** — low-latency writes via DO transactional storage
- **R2 cold segments** — automatic rotation of historical data to immutable R2 objects
- **Protocol-correct caching** — Cache-Control headers per Durable Streams spec, CDN-friendly
- **Long-poll + SSE** — real-time delivery with catch-up reads
- **DO hibernation** — SSE via internal WebSocket bridge lets the DO sleep between writes
- **JSON mode** — array flattening, JSON validation, message-count offsets
- **TTL / Expires-At** — stream-level time-to-live enforcement
- **Idempotent producers** — epoch/seq-based duplicate detection
- **Conformance-tested** — passes the official Durable Streams test suite

### Pub/Sub Subscriptions (Estuary)

- **Fan-out to subscribers** — publish once, distribute to N estuary streams
- **Inline & queued fan-out** — synchronous for <200 subscribers, queued for hot topics
- **Circuit breaker** — protects publish path when subscribers fail
- **Estuary TTL** — automatic cleanup of inactive subscription streams
- **Content-type validation** — estuaries inherit source stream content type

### Hono Integration

- **JWT authentication** — `hono/jwt` for HMAC-SHA256 token verification
- **CORS middleware** — `hono/cors` with per-project origin configuration
- **HTTP logger** — `hono/logger` for request logging
- **Timing headers** — `hono/timing` for Server-Timing diagnostics

## Quick Start

### 1. Install

```bash
npm install @durable-streams-cloudflare/server
```

### 2. Create Your Worker

`src/worker.ts`:

```ts
import {
  ServerWorker,
  StreamDO,
  SubscriptionDO,
  EstuaryDO,
} from "@durable-streams-cloudflare/server";

export default ServerWorker;
export { StreamDO, SubscriptionDO, EstuaryDO };
```

`wrangler.toml`:

```toml
name = "durable-streams-server"
main = "src/worker.ts"
compatibility_date = "2026-02-02"

[durable_objects]
bindings = [
  { name = "STREAMS", class_name = "StreamDO" },
  { name = "SUBSCRIPTION_DO", class_name = "SubscriptionDO" },
  { name = "ESTUARY_DO", class_name = "EstuaryDO" },
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["StreamDO"]

[[migrations]]
tag = "v2"
new_sqlite_classes = ["SubscriptionDO"]

[[migrations]]
tag = "v3"
new_sqlite_classes = ["EstuaryDO"]

[[r2_buckets]]
binding = "R2"
bucket_name = "durable-streams"

[[analytics_engine_datasets]]
binding = "METRICS"
dataset = "durable_streams_metrics"

[[kv_namespaces]]
binding = "REGISTRY"
id = "your-kv-namespace-id"

# Optional: Queue-based fanout for hot topics
[[queues.producers]]
binding = "FANOUT_QUEUE"
queue = "subscription-fanout"

[vars]
ESTUARY_TTL_SECONDS = "86400"
```

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

````

### 3. Deploy

```bash
npx wrangler r2 bucket create durable-streams
npx wrangler deploy
````

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

| Claim       | Required | Description                                         |
| ----------- | -------- | --------------------------------------------------- |
| `sub`       | Yes      | Must match the project ID in the URL path           |
| `scope`     | Yes      | `"write"` (read+write) or `"read"` (read-only)      |
| `exp`       | Yes      | Unix timestamp expiry                               |
| `stream_id` | No       | If present, restricts reads to this specific stream |

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
  request: Request,
  doKey: string,
  env: E,
  timing: Timing | null,
) => AuthResult | Promise<AuthResult>;

type AuthorizeRead<E> = (
  request: Request,
  doKey: string,
  env: E,
  timing: Timing | null,
) => ReadAuthResult | Promise<ReadAuthResult>;

type AuthResult = { ok: true } | { ok: false; response: Response };
type ReadAuthResult = { ok: true } | { ok: false; response: Response };
```

## API

All endpoints are under `/v1/stream/:id`.

| Method   | Description                                                                   |
| -------- | ----------------------------------------------------------------------------- |
| `PUT`    | Create a stream (optional body as first message)                              |
| `POST`   | Append a message (or close the stream)                                        |
| `GET`    | Read messages — catch-up, long-poll (`?live=long-poll`), or SSE (`?live=sse`) |
| `HEAD`   | Get stream metadata headers without body                                      |
| `DELETE` | Delete a stream and all its data                                              |

**Query parameters:** `offset` (start reading from this position), `live` (`long-poll` or `sse`).

See the [Durable Streams protocol spec](https://github.com/electric-sql/durable-streams) for full details on headers, offsets, and producer semantics.

## Configuration

### Environment Variables

| Variable               | Default   | Description                                 |
| ---------------------- | --------- | ------------------------------------------- |
| `DEBUG_TIMING`         | `0`       | Set to `1` to emit `Server-Timing` headers  |
| `SEGMENT_MAX_MESSAGES` | `1000`    | Max messages per R2 segment before rotation |
| `SEGMENT_MAX_BYTES`    | `4194304` | Max bytes per R2 segment before rotation    |

### Wrangler Bindings

| Binding    | Type             | Description                                                                                |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `STREAMS`  | Durable Object   | StreamDO namespace (required)                                                              |
| `R2`       | R2 Bucket        | Cold segment storage (required)                                                            |
| `REGISTRY` | KV Namespace     | Per-project signing secrets and public stream flags (required when using `projectJwtAuth`) |
| `METRICS`  | Analytics Engine | Stream operation metrics (optional)                                                        |

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

## API Routes

### Core Streaming Routes

#### `PUT /v1/stream/:projectIdAndStreamId`

Create or touch a stream. Requires write or manage scope JWT.

**Headers:**

- `Authorization: Bearer <JWT>` (required)
- `Content-Type: application/json` (or your preferred type)
- `Stream-Expires-At: <ISO8601>` (optional TTL)

**Response:** `201 Created` or `409 Conflict` if already exists with different content-type

#### `POST /v1/stream/:projectIdAndStreamId`

Append a message to the stream. Requires write or manage scope JWT.

**Headers:**

- `Authorization: Bearer <JWT>` (required)
- `Content-Type: application/json` (must match stream content-type)
- `Producer-Id`, `Producer-Epoch`, `Producer-Seq` (optional idempotency)

**Body:** Message payload (JSON array if content-type is application/json)

**Response:** `200 OK` with `Stream-Next-Offset` header

#### `GET /v1/stream/:projectIdAndStreamId`

Read from a stream. Requires read, write, or manage scope JWT (or public stream).

**Query Parameters:**

- `offset=<hex>` (required) - Offset to read from
- `live=long-poll|sse` (optional) - Real-time mode
- `limit=<N>` (optional) - Max messages per response

**Response:** `200 OK` with messages, `Stream-Next-Offset`, `Stream-Up-To-Date` headers

#### `DELETE /v1/stream/:projectIdAndStreamId`

Delete a stream. Requires manage scope JWT.

**Response:** `200 OK`

### Subscription Routes (Estuary)

#### `POST /v1/estuary/subscribe/:projectIdAndStreamId`

Subscribe an estuary to a stream. Creates the estuary stream if it doesn't exist.

**Body:**

```json
{
  "estuaryId": "user-123",
  "contentType": "application/json"
}
```

**Response:**

```json
{
  "estuaryId": "user-123",
  "streamId": "notifications",
  "estuaryStreamPath": "/v1/stream/my-project/user-123",
  "expiresAt": 1738986400000,
  "isNewEstuary": true
}
```

#### `DELETE /v1/estuary/subscribe/:projectIdAndStreamId`

Unsubscribe an estuary from a stream.

**Body:**

```json
{
  "estuaryId": "user-123"
}
```

**Response:**

```json
{
  "estuaryId": "user-123",
  "streamId": "notifications",
  "unsubscribed": true
}
```

#### `GET /v1/estuary/:projectId/:estuaryId`

Get estuary information including all subscriptions.

**Response:**

```json
{
  "estuaryId": "user-123",
  "estuaryStreamPath": "/v1/stream/my-project/user-123",
  "subscriptions": [{ "streamId": "notifications" }, { "streamId": "alerts" }],
  "contentType": "application/json"
}
```

#### `DELETE /v1/estuary/:projectId/:estuaryId`

Delete an estuary stream and all its subscriptions.

**Response:**

```json
{
  "estuaryId": "user-123",
  "deleted": true
}
```

### Configuration Routes

#### `GET /v1/config/:projectId`

Get project configuration (signing secrets, CORS origins).

#### `PUT /v1/config/:projectId`

Update project configuration.

## Pub/Sub Usage Example

```bash
# 1. Create source stream
curl -X PUT -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $JWT" \
  $URL/v1/stream/my-project/notifications

# 2. Subscribe user estuaries
curl -X POST -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $JWT" \
  -d '{"estuaryId":"user-alice"}' \
  $URL/v1/estuary/subscribe/my-project/notifications

curl -X POST -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $JWT" \
  -d '{"estuaryId":"user-bob"}' \
  $URL/v1/estuary/subscribe/my-project/notifications

# 3. Publish to source stream (fans out to all subscribers)
curl -X POST -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $JWT" \
  -d '{"type":"alert","message":"System maintenance in 10 minutes"}' \
  $URL/v1/stream/my-project/notifications

# 4. Each user reads their own estuary stream
curl -H "Authorization: Bearer $JWT_ALICE" \
  "$URL/v1/stream/my-project/user-alice?offset=0000000000000000_0000000000000000&live=sse"

curl -H "Authorization: Bearer $JWT_BOB" \
  "$URL/v1/stream/my-project/user-bob?offset=0000000000000000_0000000000000000&live=sse"
```

## Architecture

### Three Durable Objects

1. **StreamDO** - Per-stream sequencer (hot log + R2 segments)
2. **SubscriptionDO** - Per-stream subscriber registry + fanout logic
3. **EstuaryDO** - Per-user subscription tracker + TTL cleanup

### Internal API

Subscription functionality calls stream operations via `internal-api.ts` which directly invokes StreamDO methods. No HTTP or worker-to-worker RPC overhead.

### Fan-out Modes

| Subscriber Count | Mode         | Behavior                                           |
| ---------------- | ------------ | -------------------------------------------------- |
| ≤ 200 (default)  | Inline       | Synchronous fanout within publish request          |
| > 200            | Queued       | Enqueues batches to `FANOUT_QUEUE`, async delivery |
| Circuit open     | Circuit-open | Inline fanout skipped after repeated failures      |

## Migration from Core + Subscription

If you're currently running separate `@durable-streams-cloudflare/core` and `@durable-streams-cloudflare/subscription` workers:

1. Deploy `@durable-streams-cloudflare/server` as a new worker
2. Update client code to point to new routes:
   - `/v1/estuary/publish/:projectIdAndStreamId` → Use `/v1/stream/:projectIdAndStreamId` (POST)
   - `/v1/estuary/subscribe/:projectIdAndStreamId` → Same path, new worker
3. No data migration needed - DOs migrate automatically when accessed
4. Remove old workers once verified

## Development

```bash
pnpm install
pnpm dev          # Start local dev server
pnpm typecheck    # Run TypeScript compiler
pnpm lint         # Run oxlint
pnpm test:unit    # Run unit tests
```

## License

MIT
