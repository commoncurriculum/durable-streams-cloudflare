# Durable Streams on Cloudflare

Real-time append-only logs and pub/sub fan-out on Cloudflare Workers + Durable Objects.

Implements the [Durable Streams](https://github.com/electric-sql/durable-streams) protocol by Electric SQL. Conformance-tested against the official test suite.

## Why

Cloudflare has all the primitives for real-time streaming — Durable Objects for sequencing, SQLite for durable writes, R2 for cold storage, WebSockets for push — but wiring them together correctly is hard. The billing model punishes you if you get it wrong: a naive SSE implementation costs **$4,000/month** for 1,000 connections. With DO hibernation and CDN request collapsing, this drops to **$18/month** for 10,000 readers.

This project handles that wiring: the hibernation bridge, the cache headers, the segment rotation, the producer fencing — so you get a standards-compliant streaming API that scales on Cloudflare without surprise bills.

## What's in the Box

The CLI setup wizard deploys up to **four Workers** and an **nginx reverse proxy** (all optional — pick what you need):

| Component                                                            | Package                                                                          | What                                                                                                                                             |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Streams Worker** — Durable Streams server on CF Workers            | [`@durable-streams-cloudflare/core`](packages/core/)                             | One DO per stream, SQLite hot log, R2 cold segments, CDN caching, long-poll + SSE, DO hibernation.                                               |
| **Subscription Worker** — combines N source streams into 1 stream    | [`@durable-streams-cloudflare/subscription`](packages/subscription/)             | Pub/sub fan-out, session lifecycle, TTL cleanup, Analytics Engine metrics. Requires the streams worker.                                          |
| **Nginx Proxy** — enables CDN caching for 99% hit rate at $0/request | [`packages/proxy`](packages/proxy/)                                              | Reverse proxy that puts Cloudflare CDN in front of the streams worker. Without it, every read executes a Worker; with it, cached reads are free. |
| **Admin (Streams)** — dashboard for stream inspection                | [`@durable-streams-cloudflare/admin-core`](packages/admin-core/)                 | Browse streams, view metadata, read contents, manage projects.                                                                                   |
| **Admin (Subscription)** — dashboard for subscription metrics        | [`@durable-streams-cloudflare/admin-subscription`](packages/admin-subscription/) | Monitor fan-out, sessions, publish rates, cleanup.                                                                                               |

The streams worker works standalone. Subscription depends on it. The proxy and admin dashboards are optional.

## Quick Start

```bash
# 1. Log in to Cloudflare
pnpx wrangler login

# 2. Run the setup wizard
pnpx @durable-streams-cloudflare/cli setup
```

The wizard asks which of the four workers to deploy, creates the Cloudflare resources (R2 bucket, KV namespace), scaffolds a pnpm workspace, installs dependencies, and deploys.

Then create your first project (generates a JWT signing secret for auth):

```bash
pnpx @durable-streams-cloudflare/cli create-project
```

---

## Part 1: Durable Streams

A Cloudflare Worker implementation of the [Durable Streams](https://github.com/electric-sql/durable-streams) HTTP protocol — append-only logs with real-time delivery.

### Why Durable Streams

You need an ordered, durable log that clients can read in real time. Think collaborative editing, activity feeds, event sourcing, or any case where multiple clients need to catch up from an offset and then tail new writes as they arrive.

Durable Streams gives you that as an HTTP protocol: `PUT` to create, `POST` to append, `GET` to read (with catch-up, long-poll, and SSE). Offsets, producer fencing, idempotent appends — it's all in the spec.

This package implements that spec on Cloudflare:

- **One Durable Object per stream** — single-threaded sequencer, strong ordering, no coordination overhead
- **SQLite hot log** — writes ACK after a single SQLite transaction (no object storage in the write path)
- **R2 cold segments** — historical data rotates to immutable R2 objects automatically
- **SSE via DO hibernation** — an internal WebSocket bridge lets the DO sleep between writes; edge workers hold client SSE connections at zero cost
- **CDN-friendly** — cache headers are designed for Cloudflare CDN request collapsing; cached reads cost $0

### Try It

```bash
URL=https://durable-streams.<your-subdomain>.workers.dev

# Create a stream
curl -X PUT -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  $URL/v1/my-project/stream/my-stream

# Append a message
curl -X POST -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"op":"insert","text":"hello"}' \
  $URL/v1/my-project/stream/my-stream

# Catch-up read
curl -H "Authorization: Bearer $JWT" \
  "$URL/v1/my-project/stream/my-stream?offset=0000000000000000_0000000000000000"

# SSE (real-time tail)
curl -N -H "Authorization: Bearer $JWT" \
  "$URL/v1/my-project/stream/my-stream?offset=0000000000000000_0000000000000000&live=sse"
```

See the [streams worker README](packages/core/README.md) for the full API, auth options, and configuration.

---

## Part 2: Pub/Sub on Durable Streams

A second Worker that adds session-based pub/sub fan-out on top of the streams worker.

### Why Pub/Sub

Durable Streams gives you one stream per resource. But often a client cares about _many_ resources — an editor watching hundreds of small objects across a project, or a dashboard tracking dozens of feeds. You don't want the client opening hundreds of SSE connections.

The subscription layer solves this: each client gets a **session stream**. Subscribe a session to any number of source streams. When a message is published, the subscription worker fans it out — writing a copy to every subscriber's session stream. The client reads a single SSE connection from the streams worker and gets updates from all their subscriptions.

- **Publish once, fan out to N** — the publisher doesn't know or care how many subscribers exist
- **Session streams are real Durable Streams** — clients read them via the streams worker with full catch-up, CDN caching, and SSE
- **Automatic cleanup** — sessions expire via TTL, a cron job removes stale subscriptions
- **Producer deduplication** — fan-out writes use producer fencing, so retries are idempotent

### Try It

Assumes the streams worker is already deployed.

```bash
CORE=https://durable-streams.<your-subdomain>.workers.dev
SUB=https://durable-streams-subscriptions.<your-subdomain>.workers.dev

# First, create a source stream on the streams worker
curl -X PUT -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  $CORE/v1/my-project/stream/chat-room-1

# Subscribe a session to that stream
curl -X POST -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"streamId":"chat-room-1","sessionId":"user-alice"}' \
  $SUB/v1/my-project/subscribe

# Publish a message — fans out to all subscribers
curl -X POST -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"text":"hello world"}' \
  $SUB/v1/my-project/publish/chat-room-1

# Read the session stream via SSE (from the streams worker)
curl -N -H "Authorization: Bearer $JWT" \
  "$CORE/v1/my-project/stream/session:user-alice?offset=0000000000000000_0000000000000000&live=sse"
```

See the [subscription README](packages/subscription/README.md) for the full API, session lifecycle, and configuration.

---

## Part 3: Nginx Proxy (CDN Layer)

An nginx reverse proxy that puts Cloudflare's CDN in front of the streams worker.

### Why the Proxy

Cloudflare's CDN serves cached responses **without executing the Worker at all** — a CDN HIT costs $0 in Worker requests, $0 in DO requests, $0 in bandwidth. This is the single biggest cost lever in the system: it's the difference between $11,700/month and $18/month at 10K readers.

The problem: Cloudflare's CDN can't proxy directly to a `*.workers.dev` domain. You need an origin server for the CDN to point at. The nginx proxy is that origin — a minimal pass-through that forwards requests to the streams worker so the CDN can cache responses on the way back.

```
CDN HIT:   Client → Cloudflare CDN → cached response ($0)
CDN MISS:  Client → Cloudflare CDN → nginx → Streams Worker → DO
```

The proxy itself is intentionally dumb: no caching, no auth, no buffering. It passes through all Durable Streams headers and keeps connections open for long-poll and SSE. It runs on a $6/month VPS (DigitalOcean) or a free Oracle Cloud VM.

### Setup

```bash
docker build -t durable-streams-proxy packages/proxy
docker run -e SERVER_NAME=ds-stream.yourdomain.com \
           -e ORIGIN_HOST=durable-streams.<your-subdomain>.workers.dev \
           -p 80:80 durable-streams-proxy
```

Then point a Cloudflare-proxied DNS record at the VPS. See the [proxy README](packages/proxy/README.md) for details.

---

## Part 4: Admin Dashboards

Two optional TanStack Start apps deployed as Cloudflare Workers — one for streams, one for subscriptions. They connect to their respective workers via service bindings (no auth tokens needed) and read metrics from Analytics Engine.

### Streams Admin

- **Overview** — stream activity stats, throughput timeseries, hot streams, full stream list
- **Inspect** — drill into a stream to see metadata, ops count, R2 segments, producer state, real-time client counts (WebSocket/SSE/long-poll)
- **Test** — create streams and append messages from the browser, with a live SSE event log

See the [streams admin README](packages/admin-core/README.md) for setup and configuration.

### Subscription Admin

- **Overview** — real-time metrics (publishes/min, fanout latency, active sessions/streams, success rates), throughput chart, hot streams, publish errors
- **Inspect** — drill into a session (subscriptions, TTL) or stream (subscribers)
- **Test** — subscribe, unsubscribe, publish, touch, and delete sessions from the browser, with a live SSE event log

See the [subscription admin README](packages/admin-subscription/README.md) for setup and configuration.

Both dashboards use [Cloudflare Zero Trust](https://developers.cloudflare.com/cloudflare-one/applications/) for authentication — without it, they're publicly accessible.

---

## Architecture

```
Writes (Streams Worker)
  Client ── POST /v1/:project/stream/:id ──> Edge Worker (auth, CORS)
                                               └──> StreamDO ──> SQLite
                                                     ├── broadcast to live readers
                                                     └── R2 rotation (when full)

SSE Reads (Streams Worker)
  Client <── SSE ──── Edge Worker <── WebSocket (Hibernation API) ──── StreamDO
                      (idle = $0)                                       (sleeps between
                                                                         writes)

Pub/Sub Fan-Out (Subscription Worker)
  Publisher ── POST /v1/:project/publish/:streamId ──> Subscription Worker
                                                        ├─> Streams: write to source stream
                                                        ├─> SubscriptionDO: get subscribers
                                                        └─> Fan-out: write to each session stream
```

## Manual Setup

If you prefer to set things up by hand instead of using the CLI, see the individual package READMEs:

- [Streams worker README](packages/core/README.md) — worker setup, wrangler.toml, auth configuration
- [Subscription README](packages/subscription/README.md) — worker setup, service bindings, cron cleanup

## Releasing

This repo uses [Changesets](https://github.com/changesets/changesets) for versioning and npm publishing.

1. **Add a changeset** before merging your PR:

   ```bash
   pnpm changeset
   ```

   Pick which packages changed and whether it's a patch, minor, or major bump.

2. **Merge to main.** The publish workflow opens a "chore: version packages" PR that bumps versions and updates changelogs.

3. **Merge the version PR.** The workflow publishes to npm automatically.

All three public packages (`core`, `subscription`, `cli`) stay on the same version number via the `fixed` config in `.changeset/config.json`.

## Credits

The streams worker implements the [Durable Streams](https://github.com/electric-sql/durable-streams) protocol by Electric SQL. Conformance-tested against the official test suite.

## License

MIT
