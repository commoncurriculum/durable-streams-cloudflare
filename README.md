# durable-streams-cloudflare

This repo contains two independent projects:

|          | What                                                                                                                                          | Package                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Port** | Cloudflare Workers implementation of the existing [Durable Streams](https://github.com/electric-sql/durable-streams) protocol by Electric SQL | [`@durable-streams-cloudflare/core`](packages/core/)                 |
| **New**  | Pub/sub subscription layer — session streams, fan-out, TTL cleanup, metrics                                                                   | [`@durable-streams-cloudflare/subscription`](packages/subscription/) |

They are separate Workers that deploy independently. The subscription worker depends on core, but core works fine on its own.

---

## Core — Durable Streams on Cloudflare

A port of the [Durable Streams](https://github.com/durable-streams/durable-streams) protocol to Cloudflare Workers + Durable Objects. One DO per stream acts as the sequencer, SQLite for the hot log, R2 for cold segments. Conformance-tested against the official test suite.

If you already know Durable Streams, this is that — running on Cloudflare instead of Caddy/filesystem.

| Package                                                                                                          | Description                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`@durable-streams-cloudflare/core`](https://www.npmjs.com/package/@durable-streams-cloudflare/core)             | DO sequencer, SQLite hot log, R2 cold segments, CDN caching, long-poll + SSE |
| [`@durable-streams-cloudflare/admin-core`](https://www.npmjs.com/package/@durable-streams-cloudflare/admin-core) | Admin dashboard for core streams                                             |

### Quick Start

```bash
npm install @durable-streams-cloudflare/core
```

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
```

```bash
npx wrangler r2 bucket create durable-streams
npx wrangler deploy
```

See the [core README](packages/core/README.md) for full details.

---

## Subscription — Pub/Sub Fan-Out

A new layer built on top of core. Subscribe sessions to source streams, publish once, fan out to all subscribers. Each subscriber gets their own session stream they can read independently via core.

| Package                                                                                                                          | Description                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`@durable-streams-cloudflare/subscription`](https://www.npmjs.com/package/@durable-streams-cloudflare/subscription)             | Session management, subscribe/publish, fan-out, TTL cleanup, Analytics Engine metrics |
| [`@durable-streams-cloudflare/admin-subscription`](https://www.npmjs.com/package/@durable-streams-cloudflare/admin-subscription) | Admin dashboard for subscriptions                                                     |

### How It Works

```
Publisher ── POST /v1/publish/stream-A ──> Subscription Worker
                                             │
                                             ├─> Core: write to source stream
                                             ├─> SubscriptionDO: get subscribers
                                             └─> Fan-out: write to each session stream
                                                  (session:alice, session:bob, ...)

Clients read their session stream directly from the Core Worker (through CDN).
```

### Quick Start

Requires a deployed core worker.

```bash
npm install @durable-streams-cloudflare/subscription
```

`src/worker.ts`:

```ts
import {
  createSubscriptionWorker,
  SubscriptionDO,
} from "@durable-streams-cloudflare/subscription";

export default createSubscriptionWorker();
export { SubscriptionDO };
```

`wrangler.toml`:

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

```bash
npx wrangler deploy
```

See the [subscription README](packages/subscription/README.md) for full details.

---

## Try Them Together

```bash
CORE=https://durable-streams.<your-subdomain>.workers.dev
SUB=https://durable-streams-subscriptions.<your-subdomain>.workers.dev

# Create a stream (core)
curl -X PUT $CORE/v1/stream/chat-room-1

# Subscribe a session (subscription)
curl -X POST $SUB/v1/subscribe \
  -H 'Content-Type: application/json' \
  -d '{"streamId":"chat-room-1","sessionId":"user-alice"}'

# Publish a message — fans out to all subscribers (subscription)
curl -X POST $SUB/v1/publish/chat-room-1 \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello world"}'

# Read the session stream via SSE (core)
curl -N "$CORE/v1/stream/session:user-alice?offset=0000000000000000_0000000000000000&live=sse"

# Check session info (subscription)
curl $SUB/v1/session/user-alice

# Extend session TTL (subscription)
curl -X POST $SUB/v1/session/user-alice/touch

# Unsubscribe (subscription)
curl -X DELETE $SUB/v1/unsubscribe \
  -H 'Content-Type: application/json' \
  -d '{"streamId":"chat-room-1","sessionId":"user-alice"}'
```

## Credits

Core implements the [Durable Streams](https://github.com/electric-sql/durable-streams) protocol by Electric SQL. Conformance-tested against the official test suite.

## License

MIT
