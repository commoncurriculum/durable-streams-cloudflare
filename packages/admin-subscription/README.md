# @durable-streams-cloudflare/admin-subscription

Admin dashboard for [`@durable-streams-cloudflare/subscription`](https://www.npmjs.com/package/@durable-streams-cloudflare/subscription). A TanStack Start app deployed as a Cloudflare Worker, providing a React-based dashboard for monitoring pub/sub activity, inspecting sessions and streams, and testing subscription operations.

Connects to the subscription worker via service binding. Reads metrics from Analytics Engine.

## Dashboard

The admin dashboard has three views:

- **Overview** — real-time metrics (publishes/min, fanout latency, active sessions/streams, success rates), throughput chart, hot streams, publish errors
- **Inspect** — drill into a specific session (subscriptions, TTL) or stream (subscribers). Auto-refreshes on 2s polling.
- **Test** — subscribe, unsubscribe, publish, touch, and delete sessions directly from the browser, with a live SSE event log

## Tech Stack

- **TanStack Start** — SSR React framework with server functions
- **TanStack Query** — auto-polling data fetching (5s refresh)
- **Recharts** — timeseries and sparkline charts
- **Tailwind CSS v4** — styling
- **@cloudflare/vite-plugin** — Cloudflare Workers deployment

## Development

```bash
pnpm install
pnpm dev          # vite dev on port 8789
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
```

## Deploy

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_API_TOKEN
pnpm deploy       # vite build && wrangler deploy
```

## Configuration

| Variable | Description |
|----------|-------------|
| `ADMIN_TOKEN` | Auth token for proxied requests to the subscription worker |
| `CF_ACCOUNT_ID` | Cloudflare account ID for Analytics Engine queries |
| `CF_API_TOKEN` | Cloudflare API token with Analytics Engine read permission |

| Binding | Type | Description |
|---------|------|-------------|
| `SUBSCRIPTION` | Service Binding | Service binding to the subscription worker (required) |
| `CORE` | Service Binding | Service binding to the core worker (required, for SSE proxy) |

## See Also

- [`@durable-streams-cloudflare/subscription`](https://www.npmjs.com/package/@durable-streams-cloudflare/subscription) — the subscription/pub-sub layer
- [`@durable-streams-cloudflare/admin-core`](https://www.npmjs.com/package/@durable-streams-cloudflare/admin-core) — admin dashboard for core streams

## License

MIT
