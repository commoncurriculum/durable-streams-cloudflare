# @durable-streams-cloudflare/admin-core

Admin dashboard for [`@durable-streams-cloudflare/core`](https://www.npmjs.com/package/@durable-streams-cloudflare/core). A lightweight Cloudflare Worker that serves an HTML dashboard for monitoring stream activity, inspecting individual streams, and testing operations.

Connects to the core worker via service binding. Reads metrics from Analytics Engine.

## Dashboard

The admin dashboard is a single-page app with three tabs:

- **Overview** — stream activity stats, throughput timeseries chart, hot streams, full stream list
- **Inspect** — drill into a specific stream to see metadata, ops count, R2 segments, producer state, and real-time client counts (SSE/long-poll)
- **Test** — create streams and append messages directly from the browser

## Quick Start

### 1. Prerequisites

- A deployed [`@durable-streams-cloudflare/core`](https://www.npmjs.com/package/@durable-streams-cloudflare/core) worker with `ADMIN_TOKEN` and `METRICS` configured
- Your Cloudflare account ID and an API token with Analytics Engine read permissions

### 2. Install

```bash
npm install @durable-streams-cloudflare/admin-core
```

### 3. Create Your Worker

`src/worker.ts`:

```ts
export { default } from "@durable-streams-cloudflare/admin-core";
```

`wrangler.toml`:

```toml
name = "durable-streams-admin-core"
main = "src/worker.ts"
compatibility_date = "2025-02-02"

[[services]]
binding = "CORE"
service = "durable-streams"

[vars]
# Shared with core worker's ADMIN_TOKEN
# ADMIN_TOKEN = "your-admin-token"
# Required for Analytics Engine queries
# CF_ACCOUNT_ID = "your-account-id"
# CF_API_TOKEN = "your-api-token-with-analytics-read"
# For SSE live log in the dashboard
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

Open `https://durable-streams-admin-core.<your-subdomain>.workers.dev` in your browser.

## API Endpoints

The dashboard is powered by a JSON API that you can also query directly.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Admin dashboard HTML |
| `GET` | `/api/stats` | System stats — event counts by type (1h window) |
| `GET` | `/api/streams` | Active streams — first/last seen, total events (24h) |
| `GET` | `/api/hot` | Hot streams — sorted by activity (5m window). `?limit=20` |
| `GET` | `/api/timeseries` | Throughput timeseries for charts. `?window=60` (minutes, max 1440) |
| `GET` | `/api/stream/:id` | Stream introspection — metadata, ops, segments, producers, real-time clients |
| `POST` | `/api/test` | Execute test actions (create stream, append message) |

### Stream Introspection

`GET /api/stream/:id` proxies the core worker's admin endpoint (`GET /v1/stream/:id/admin`) via service binding. Returns:

- **meta** — stream ID, content type, closed status, tail offset, created/updated timestamps
- **ops** — message count and total size in the hot log
- **segments** — R2 cold segments with offsets and sizes
- **producers** — registered producers with epoch, sequence, and last offset
- **sseClientCount** / **longPollWaiterCount** — active real-time connections

### Test Actions

`POST /api/test` accepts:

```json
{ "action": "create", "streamId": "my-stream", "body": "hello", "contentType": "text/plain" }
{ "action": "append", "streamId": "my-stream", "body": "{\"text\":\"hi\"}" }
```

## Configuration

| Variable | Description |
|----------|-------------|
| `ADMIN_TOKEN` | Shared admin token (must match core worker's `ADMIN_TOKEN`) |
| `CF_ACCOUNT_ID` | Cloudflare account ID for Analytics Engine queries |
| `CF_API_TOKEN` | Cloudflare API token with Analytics Engine read permission |
| `CORE_PUBLIC_URL` | Public URL of core worker (used by dashboard for SSE live log) |

| Binding | Type | Description |
|---------|------|-------------|
| `CORE` | Service Binding | Service binding to the core worker (required) |

## See Also

- [`@durable-streams-cloudflare/core`](https://www.npmjs.com/package/@durable-streams-cloudflare/core) — the core stream protocol
- [`@durable-streams-cloudflare/admin-subscription`](https://www.npmjs.com/package/@durable-streams-cloudflare/admin-subscription) — admin dashboard for the subscription layer

## License

MIT
