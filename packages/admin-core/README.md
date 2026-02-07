# @durable-streams-cloudflare/admin-core

Admin dashboard for [`@durable-streams-cloudflare/core`](https://www.npmjs.com/package/@durable-streams-cloudflare/core). A TanStack Start app deployed as a Cloudflare Worker, providing a React-based dashboard for monitoring stream activity, inspecting individual streams, and testing operations.

Connects to the core worker via service binding. Reads metrics from Analytics Engine.

## Dashboard

The admin dashboard has three views:

- **Overview** — stream activity stats, throughput timeseries chart, hot streams, full stream list
- **Inspect** — drill into a specific stream to see metadata, ops count, R2 segments, producer state, and real-time client counts (WebSocket/SSE/long-poll)
- **Test** — create streams and append messages directly from the browser, with a live SSE event log

## Tech Stack

- **TanStack Start** — SSR React framework with server functions
- **TanStack Query** — auto-polling data fetching (5s refresh)
- **Recharts** — timeseries and sparkline charts
- **Tailwind CSS v4** — styling
- **@cloudflare/vite-plugin** — Cloudflare Workers deployment

## Development

```bash
pnpm install
pnpm dev          # vite dev on port 8790
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
```

## Deploy

```bash
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_API_TOKEN
pnpm deploy       # vite build && wrangler deploy
```

## Configuration

| Variable | Description |
|----------|-------------|
| `CF_ACCOUNT_ID` | Cloudflare account ID for Analytics Engine queries |
| `CF_API_TOKEN` | Cloudflare API token with Analytics Engine read permission |

| Binding | Type | Description |
|---------|------|-------------|
| `CORE` | Service Binding | Service binding to the core worker (required). Uses Worker RPC for stream inspection and routing — no auth tokens needed. |
| `REGISTRY` | KV Namespace | Per-project signing secrets (required for project management). Shared with the core worker. |

## Authentication

The admin dashboard relies on [Cloudflare Zero Trust (CF Access)](https://developers.cloudflare.com/cloudflare-one/applications/) for authentication. You must configure a CF Access application on the route or domain where the dashboard is deployed -- without it, the dashboard is publicly accessible.

When `CF_ACCESS_TEAM_DOMAIN` is set (your Zero Trust team name, e.g. `myteam`), the worker verifies the `cf-access-jwt-assertion` header on every request and rejects unauthenticated or expired tokens. Set it as a secret:

```bash
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
```

## See Also

- [`@durable-streams-cloudflare/core`](https://www.npmjs.com/package/@durable-streams-cloudflare/core) — the core stream protocol
- [`@durable-streams-cloudflare/admin-subscription`](https://www.npmjs.com/package/@durable-streams-cloudflare/admin-subscription) — admin dashboard for the subscription layer

## License

MIT
