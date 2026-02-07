# durable-streams-cloudflare

Durable Streams on Cloudflare — an append-only log with pub/sub fan-out, running on Workers + Durable Objects.

A port of the [Durable Streams](https://github.com/electric-sql/durable-streams) protocol to Cloudflare, plus a subscription layer for session-based pub/sub on top.

## Quick Start

The CLI handles everything: scaffolds your workers, creates Cloudflare resources (R2 bucket, KV namespace), and deploys.

```bash
# 1. Log in to Cloudflare
npx wrangler login

# 2. Run the setup wizard
npx @durable-streams-cloudflare/cli setup
```

The wizard will:
- Ask which components to deploy (core, subscription, admin dashboards)
- Create an R2 bucket and KV namespace for you
- Scaffold worker files into `workers/`
- Install npm packages
- Deploy everything to Cloudflare

Then create your first project (this generates a JWT signing secret for auth):

```bash
npx @durable-streams-cloudflare/cli create-project
```

That's it. You'll get a signing secret and instructions for minting JWTs.

## Try It

```bash
CORE=https://durable-streams.<your-subdomain>.workers.dev
SUB=https://durable-streams-subscriptions.<your-subdomain>.workers.dev

# Create a stream
curl -X PUT -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  $CORE/v1/<project>/stream/chat-room-1

# Subscribe a session
curl -X POST -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"streamId":"chat-room-1","sessionId":"user-alice"}' \
  $SUB/v1/<project>/subscribe

# Publish a message — fans out to all subscribers
curl -X POST -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"text":"hello world"}' \
  $SUB/v1/<project>/publish/chat-room-1

# Read the session stream via SSE
curl -N -H "Authorization: Bearer <JWT>" \
  "$CORE/v1/<project>/stream/session:user-alice?offset=0000000000000000_0000000000000000&live=sse"
```

## What's in the Box

| Package | What |
|---------|------|
| [`@durable-streams-cloudflare/core`](packages/core/) | Durable Streams protocol. One DO per stream, SQLite hot log, R2 cold segments, CDN caching, long-poll + SSE. |
| [`@durable-streams-cloudflare/subscription`](packages/subscription/) | Pub/sub fan-out. Session streams, subscribe/publish, TTL cleanup, Analytics Engine metrics. |
| [`@durable-streams-cloudflare/admin-core`](packages/admin-core/) | Admin dashboard for core streams. |
| [`@durable-streams-cloudflare/admin-subscription`](packages/admin-subscription/) | Admin dashboard for subscriptions. |
| [`@durable-streams-cloudflare/cli`](packages/cli/) | Setup wizard and project management CLI. |

Core and subscription are separate Workers that deploy independently. Subscription depends on core, but core works fine on its own.

See each package's README for full API docs, configuration options, and auth details.

## Architecture

```
Publisher ── POST /v1/publish/stream-A ──> Subscription Worker
                                             │
                                             ├─> Core: write to source stream
                                             ├─> SubscriptionDO: get subscribers
                                             └─> Fan-out: write to each session stream
                                                  (session:alice, session:bob, ...)

Clients read their session stream directly from the Core Worker (through CDN).
```

## Manual Setup

If you prefer to set things up by hand instead of using the CLI, see the individual package READMEs:
- [Core README](packages/core/README.md) — worker setup, wrangler.toml, auth configuration
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

Core implements the [Durable Streams](https://github.com/electric-sql/durable-streams) protocol by Electric SQL. Conformance-tested against the official test suite.

## License

MIT
