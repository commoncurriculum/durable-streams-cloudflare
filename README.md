# durable-streams-cloudflare

Cloudflare Workers implementation of the [Durable Streams](https://github.com/electric-sql/durable-streams) protocol — low-latency writes via Durable Objects, CDN-compatible reads, and pub/sub fan-out.

A Durable Object per stream acts as the sequencer, with SQLite as the hot log and R2 for immutable cold segments. The subscription layer adds session management and fan-out on top.

## How It Works

These are **libraries**, not pre-built services. You create a Cloudflare Worker project, import the factory function, wire up your auth, and deploy with `wrangler deploy`.

```
my-streams-project/
  src/worker.ts      ← import createStreamWorker(), configure auth
  wrangler.toml      ← DO bindings, R2 bucket, env vars
  package.json       ← depends on @durable-streams-cloudflare/*
```

Your worker file is ~5 lines. The libraries handle protocol compliance, storage, caching, and real-time delivery.

## Packages

| Package | Description |
|---------|-------------|
| [`@durable-streams-cloudflare/core`](https://www.npmjs.com/package/@durable-streams-cloudflare/core) | Durable Streams HTTP protocol — DO sequencer, SQLite hot log, R2 cold segments, CDN caching, long-poll + SSE |
| [`@durable-streams-cloudflare/subscription`](https://www.npmjs.com/package/@durable-streams-cloudflare/subscription) | Pub/sub fan-out — session streams, subscribe/publish, TTL cleanup, Analytics Engine metrics |
| [`@durable-streams-cloudflare/admin-core`](https://www.npmjs.com/package/@durable-streams-cloudflare/admin-core) | Admin dashboard for core streams |
| [`@durable-streams-cloudflare/admin-subscription`](https://www.npmjs.com/package/@durable-streams-cloudflare/admin-subscription) | Admin dashboard for subscriptions |

## Architecture

```
                        ┌──────────────────────────┐
  Client (read)         │      Core Worker          │
  GET /v1/stream/:id ──>│  auth → cache → StreamDO  │
  (via CDN)             │         │                  │
                        │    SQLite hot log          │
                        │    R2 cold segments        │
                        └──────────────────────────┘
                                   ^
                                   │ service binding
                                   │ (or CORE_URL)
                        ┌──────────┴───────────────┐
  Client (pub/sub)      │   Subscription Worker     │
  POST /v1/subscribe    │  auth → route             │
  POST /v1/publish/:id  │    │                      │
  GET  /v1/session/:id  │    ├─> Core: write source  │
                        │    ├─> SubscriptionDO:     │
                        │    │   get subscribers     │
                        │    └─> Fan-out: write to   │
                        │        each session stream │
                        └──────────────────────────┘
```

The core worker owns stream storage and the HTTP protocol. The subscription worker manages sessions and fan-out, delegating all stream I/O to core via service binding (recommended) or HTTP.

## Quick Start

### 1. Set Up the Core Worker

```bash
npm install @durable-streams-cloudflare/core
```

Create `src/worker.ts`:

```ts
import { createStreamWorker, StreamDO } from "@durable-streams-cloudflare/core";

export default createStreamWorker();
export { StreamDO };
```

Create `wrangler.toml`:

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
```

Deploy:

```bash
npx wrangler r2 bucket create durable-streams
npx wrangler deploy
```

### 2. Set Up the Subscription Worker

```bash
npm install @durable-streams-cloudflare/subscription
```

Create `src/worker.ts`:

```ts
import { createSubscriptionWorker, SubscriptionDO } from "@durable-streams-cloudflare/subscription";

export default createSubscriptionWorker();
export { SubscriptionDO };
```

Create `wrangler.toml`:

```toml
name = "durable-streams-subscriptions"
main = "src/worker.ts"
compatibility_date = "2025-02-02"

[vars]
CORE_URL = "https://durable-streams.<your-subdomain>.workers.dev"
SESSION_TTL_SECONDS = "1800"

[durable_objects]
bindings = [{ name = "SUBSCRIPTION_DO", class_name = "SubscriptionDO" }]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["SubscriptionDO"]

# Optional: service binding to core (recommended for production)
# [[services]]
# binding = "CORE"
# service = "durable-streams"

[triggers]
crons = ["*/5 * * * *"]
```

Deploy:

```bash
npx wrangler deploy
```

### 3. Try It

```bash
CORE=https://durable-streams.<your-subdomain>.workers.dev
SUB=https://durable-streams-subscriptions.<your-subdomain>.workers.dev

# Create a stream
curl -X PUT $CORE/v1/stream/chat-room-1

# Subscribe a session
curl -X POST $SUB/v1/subscribe \
  -H 'Content-Type: application/json' \
  -d '{"streamId":"chat-room-1","sessionId":"user-alice"}'

# Publish a message (fans out to all subscribers)
curl -X POST $SUB/v1/publish/chat-room-1 \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello world"}'

# Read the session stream via core (SSE)
curl -N "$CORE/v1/stream/session:user-alice?offset=0000000000000000_0000000000000000&live=sse"

# Check session info
curl $SUB/v1/session/user-alice

# Extend session TTL
curl -X POST $SUB/v1/session/user-alice/touch

# Unsubscribe
curl -X DELETE $SUB/v1/unsubscribe \
  -H 'Content-Type: application/json' \
  -d '{"streamId":"chat-room-1","sessionId":"user-alice"}'
```

## Why Not Just a Durable Object?

Durable Objects provide single-threaded state + storage, but they don't implement:

- The Durable Streams HTTP protocol (offsets, cursors, TTL/expiry, headers)
- Producer idempotency and sequencing (epoch/seq enforcement)
- Catch-up semantics + long-poll + SSE
- CDN-aware caching behavior
- Cold-segment rotation and R2 read-seq encoding
- Conformance guarantees against the official test suite

These libraries layer the full Durable Streams protocol and storage model on top of Cloudflare's DOs.

## Credits

Implements the [Durable Streams](https://github.com/electric-sql/durable-streams) protocol by Electric SQL. Conformance-tested against the official test suite.

## License

MIT
