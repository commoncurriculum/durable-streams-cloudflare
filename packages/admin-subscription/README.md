# @durable-streams-cloudflare/admin-subscription

Admin dashboard for [`@durable-streams-cloudflare/subscription`](https://www.npmjs.com/package/@durable-streams-cloudflare/subscription). A lightweight Cloudflare Worker that serves an HTML dashboard for monitoring pub/sub activity, inspecting sessions and streams, and testing subscription operations.

Connects to the subscription worker via service binding. Reads metrics from Analytics Engine.

## Dashboard

The admin dashboard is a single-page app with three tabs:

- **Overview** — real-time metrics (publishes/min, fanout latency, active sessions/streams, success rates), throughput chart, hot streams, publish errors
- **Inspect** — drill into a specific session (subscriptions, TTL) or stream (subscribers). Auto-refreshes on 2s polling.
- **Test** — subscribe, unsubscribe, publish, touch, and delete sessions directly from the browser, with a live SSE event log

## Quick Start

### 1. Prerequisites

- A deployed [`@durable-streams-cloudflare/subscription`](https://www.npmjs.com/package/@durable-streams-cloudflare/subscription) worker with `METRICS` configured
- Your Cloudflare account ID and an API token with Analytics Engine read permissions

### 2. Install

```bash
npm install @durable-streams-cloudflare/admin-subscription
```

### 3. Create Your Worker

`src/worker.ts`:

```ts
export { default } from "@durable-streams-cloudflare/admin-subscription";
```

`wrangler.toml`:

```toml
name = "durable-streams-admin-subscription"
main = "src/worker.ts"
compatibility_date = "2025-02-02"

[[services]]
binding = "SUBSCRIPTION"
service = "durable-streams-subscriptions"

[vars]
# Shared with subscription worker's AUTH_TOKEN
# ADMIN_TOKEN = "your-admin-token"
# Required for Analytics Engine queries
# CF_ACCOUNT_ID = "your-account-id"
# CF_API_TOKEN = "your-api-token"
# For dashboard display and SSE live log
# SUBSCRIPTION_PUBLIC_URL = "https://durable-streams-subscriptions.your-domain.workers.dev"
# CORE_PUBLIC_URL = "https://durable-streams.your-domain.workers.dev"

[observability]
enabled = true
```

### 4. Deploy

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_API_TOKEN
npx wrangler deploy
```

Open `https://durable-streams-admin-subscription.<your-subdomain>.workers.dev` in your browser.

## API Endpoints

The dashboard is powered by a JSON API that you can also query directly.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Admin dashboard HTML |
| `GET` | `/api/stats` | System stats + fanout metrics (1h window) |
| `GET` | `/api/sessions` | Active sessions (24h window) |
| `GET` | `/api/streams` | Active streams (24h window) |
| `GET` | `/api/hot` | Hot streams — sorted by publishes (5m window). `?limit=20` |
| `GET` | `/api/timeseries` | Throughput timeseries for charts. `?window=60` (minutes, max 1440) |
| `GET` | `/api/session/:id` | Session details — subscriptions, TTL info |
| `GET` | `/api/stream/:id` | Stream subscribers from Analytics Engine |
| `POST` | `/api/test` | Execute test actions against the subscription worker |

### Session Inspection

`GET /api/session/:id` proxies the subscription worker's session endpoint via service binding. Returns session info and active subscriptions.

### Test Actions

`POST /api/test` accepts:

```json
{ "action": "subscribe", "sessionId": "user-alice", "streamId": "chat-room-1" }
{ "action": "unsubscribe", "sessionId": "user-alice", "streamId": "chat-room-1" }
{ "action": "publish", "streamId": "chat-room-1", "body": "{\"text\":\"hello\"}" }
{ "action": "touch", "sessionId": "user-alice" }
{ "action": "delete", "sessionId": "user-alice" }
```

## Configuration

| Variable | Description |
|----------|-------------|
| `ADMIN_TOKEN` | Auth token for proxied requests to the subscription worker |
| `CF_ACCOUNT_ID` | Cloudflare account ID for Analytics Engine queries |
| `CF_API_TOKEN` | Cloudflare API token with Analytics Engine read permission |
| `SUBSCRIPTION_PUBLIC_URL` | Public URL of subscription worker (displayed in dashboard) |
| `CORE_PUBLIC_URL` | Public URL of core worker (used for SSE live log in Test tab) |

| Binding | Type | Description |
|---------|------|-------------|
| `SUBSCRIPTION` | Service Binding | Service binding to the subscription worker (required) |

## See Also

- [`@durable-streams-cloudflare/subscription`](https://www.npmjs.com/package/@durable-streams-cloudflare/subscription) — the subscription/pub-sub layer
- [`@durable-streams-cloudflare/admin-core`](https://www.npmjs.com/package/@durable-streams-cloudflare/admin-core) — admin dashboard for core streams

## License

MIT
