# @durable-streams-cloudflare/subscription

Pub/sub fan-out for Cloudflare, built on [`@durable-streams-cloudflare/core`](https://www.npmjs.com/package/@durable-streams-cloudflare/core). Subscribe sessions to streams, publish once and fan out to all subscribers. Automatic TTL-based session expiry, cron cleanup, and Analytics Engine metrics.

Requires `@durable-streams-cloudflare/core` deployed as a separate Worker.

This is a **library** — you import `createSubscriptionWorker()`, pass your auth config, and deploy as your own Cloudflare Worker. Same pattern as core.

## How It Works

A publisher writes to a source stream via the subscription worker. The SubscriptionDO looks up all sessions subscribed to that stream and fans out the message — writing a copy to each subscriber's session stream via core. Clients read their session stream directly from the core worker (through CDN).

```
Publisher ── POST /v1/publish/stream-A ──> Subscription Worker
                                             │
                                             ├─> Core: write to source stream
                                             ├─> SubscriptionDO: get subscribers
                                             └─> Fan-out: write to each session stream
                                                  (session:alice, session:bob, ...)

Client ── GET /v1/stream/session:alice?live=sse ──> Core Worker (via CDN)
```

## Quick Start

### 1. Prerequisites

A running [`@durable-streams-cloudflare/core`](https://www.npmjs.com/package/@durable-streams-cloudflare/core) worker. See the core package README for setup.

### 2. Install

```bash
npm install @durable-streams-cloudflare/subscription
```

### 3. Create Your Worker

`src/worker.ts`:

```ts
import { createSubscriptionWorker, SubscriptionDO } from "@durable-streams-cloudflare/subscription";

export default createSubscriptionWorker();
export { SubscriptionDO };
```

`wrangler.toml`:

```toml
name = "durable-streams-subscriptions"
main = "src/worker.ts"
compatibility_date = "2025-02-02"

[vars]
SESSION_TTL_SECONDS = "1800"
ANALYTICS_DATASET = "subscriptions_metrics"

[durable_objects]
bindings = [{ name = "SUBSCRIPTION_DO", class_name = "SubscriptionDO" }]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["SubscriptionDO"]

[[analytics_engine_datasets]]
binding = "METRICS"
dataset = "subscriptions_metrics"

[[services]]
binding = "CORE"
service = "durable-streams"

[triggers]
crons = ["*/5 * * * *"]
```

### 4. Deploy

```bash
npx wrangler deploy
```

### 5. Try It

```bash
CORE=https://durable-streams.<your-subdomain>.workers.dev
SUB=https://durable-streams-subscriptions.<your-subdomain>.workers.dev

# Subscribe a session to a stream
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

## Authentication

### No Auth

`createSubscriptionWorker()` with no config allows all requests:

```ts
import { createSubscriptionWorker, SubscriptionDO } from "@durable-streams-cloudflare/subscription";

export default createSubscriptionWorker();
export { SubscriptionDO };
```

### Bearer Token

```ts
import {
  createSubscriptionWorker, SubscriptionDO, bearerTokenAuth,
} from "@durable-streams-cloudflare/subscription";

export default createSubscriptionWorker({ authorize: bearerTokenAuth() });
export { SubscriptionDO };
```

`bearerTokenAuth()` checks `env.AUTH_TOKEN` for all requests. If `AUTH_TOKEN` is not set, all requests are allowed. Clients send `Authorization: Bearer <token>`.

```bash
npx wrangler secret put AUTH_TOKEN
```

### Custom Auth

Write your own `AuthorizeSubscription` callback with full route context:

```ts
import { createSubscriptionWorker, SubscriptionDO } from "@durable-streams-cloudflare/subscription";
import type { AuthorizeSubscription, SubscriptionRoute } from "@durable-streams-cloudflare/subscription";

export default createSubscriptionWorker({
  authorize: async (request, route, env) => {
    // Allow session reads without auth
    if (route.action === "getSession") return { ok: true };

    // Require token for publish
    if (route.action === "publish") {
      const token = request.headers.get("Authorization");
      if (token !== `Bearer ${env.AUTH_TOKEN}`) {
        return { ok: false, response: new Response("forbidden", { status: 403 }) };
      }
    }

    // Check session ownership for session operations
    if ("sessionId" in route) {
      const userId = request.headers.get("X-User-Id");
      if (route.sessionId !== userId) {
        return { ok: false, response: new Response("forbidden", { status: 403 }) };
      }
    }

    return { ok: true };
  },
});
export { SubscriptionDO };
```

The `route` parameter is a discriminated union (`SubscriptionRoute`) with the parsed action and IDs:

- `{ action: "publish", streamId }` — publish to a stream
- `{ action: "subscribe", streamId, sessionId }` — subscribe a session
- `{ action: "unsubscribe", streamId, sessionId }` — unsubscribe a session
- `{ action: "getSession", sessionId }` — read session info
- `{ action: "touchSession", sessionId }` — extend session TTL
- `{ action: "deleteSession", sessionId }` — delete a session

**Type signatures:**

```ts
type AuthorizeSubscription<E> = (
  request: Request, route: SubscriptionRoute, env: E,
) => SubscriptionAuthResult | Promise<SubscriptionAuthResult>;

type SubscriptionAuthResult = { ok: true } | { ok: false; response: Response };
```

Health checks (`GET /health`) always bypass auth.

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/subscribe` | Subscribe a session to a stream. Body: `{ sessionId, streamId }` |
| `DELETE` | `/v1/unsubscribe` | Unsubscribe a session from a stream. Body: `{ sessionId, streamId }` |
| `POST` | `/v1/publish/:streamId` | Publish to a stream and fan out to all subscribers |
| `GET` | `/v1/session/:sessionId` | Get session info and active subscriptions |
| `POST` | `/v1/session/:sessionId/touch` | Extend session TTL |
| `DELETE` | `/v1/session/:sessionId` | Delete a session and its stream |
| `GET` | `/health` | Health check |

Reading the session stream is done via the **core worker**: `GET /v1/stream/session:<sessionId>`.

## Session Lifecycle

Sessions have a configurable TTL (default 30 minutes). Each `touch` resets the TTL. A cron job runs every 5 minutes, querying Analytics Engine for expired sessions and cleaning up their subscriptions and streams. Stale subscribers discovered during fan-out (core returns 404 for a deleted session stream) are also cleaned up automatically.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_TOKEN` | *(none)* | Bearer token for incoming auth (used by `bearerTokenAuth()`) |
| `SESSION_TTL_SECONDS` | `1800` | Session TTL in seconds (default: 30 minutes) |
| `CORS_ORIGINS` | `*` | Allowed CORS origins (comma-separated, `*`, or omit for all) |
| `ACCOUNT_ID` | *(none)* | Cloudflare account ID (required for cron cleanup) |
| `API_TOKEN` | *(none)* | Cloudflare API token (required for cron cleanup Analytics Engine queries) |
| `ANALYTICS_DATASET` | `subscriptions_metrics` | Analytics Engine dataset name |

### Wrangler Bindings

| Binding | Type | Description |
|---------|------|-------------|
| `SUBSCRIPTION_DO` | Durable Object | SubscriptionDO namespace (required) |
| `METRICS` | Analytics Engine | Subscription and fan-out metrics (optional) |
| `CORE` | Service Binding | Service binding to core worker (required) |

### Cron

```toml
[triggers]
crons = ["*/5 * * * *"]
```

Runs session cleanup every 5 minutes.

## Service Binding

The subscription worker communicates with core via a Cloudflare service binding — no network hop, no auth overhead. The `CORE` binding is required.

```toml
[[services]]
binding = "CORE"
service = "durable-streams"
```

## See Also

- [`@durable-streams-cloudflare/core`](https://www.npmjs.com/package/@durable-streams-cloudflare/core) — the underlying stream protocol implementation
- [Durable Streams protocol](https://github.com/electric-sql/durable-streams) — upstream spec by Electric SQL

## License

MIT
