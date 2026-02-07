# @durable-streams-cloudflare/loadtest

Load test tool for the core durable-streams worker. Two modes:

- **Local mode**: Single Node.js process holding N concurrent connections. Good for quick dev testing.
- **Distributed mode**: Deploys a load test Worker to Cloudflare. Each reader is a separate Worker invocation at the edge that connects to core's **public URL** via `fetch()`, exercising the real CDN edge cache. This tests edge cache collapsing — where 1000 concurrent readers at the same stream position collapse into a single DO round-trip.

Both modes measure write throughput, event delivery latency percentiles, x-cache header distribution, and error rates.

## Architecture

```
Local mode:
  Node process → N concurrent fetch() calls → core worker (local or deployed)

Distributed mode:
  Orchestrator (Node CLI)
    ├── Creates streams on core (HTTP)
    ├── Writes messages to streams at --write-interval
    └── Fires N POST requests to Load Test Worker
          │
          v
  Load Test Worker (deployed on Cloudflare)
    ├── Each invocation = 1 reader (SSE or long-poll)
    ├── Connects to core's PUBLIC URL (goes through CDN edge cache)
    ├── Tracks x-cache headers, delivery latency
    ├── Writes data points to Analytics Engine
    └── Returns JSON summary when done
          │
          v
  Core Worker (deployed on Cloudflare)
    └── Edge cache collapses concurrent reads → fewer DO hits
```

## Usage

```sh
cd packages/loadtest

# ── Local mode (single process, no edge cache testing) ──────────────

# Defaults: 100 clients (all SSE), 10 streams, 5 min, starts core locally
pnpm start

# 200 clients, half SSE half long-poll, 5 streams, 10 min
pnpm start -- --clients 200 --streams 5 --sse-ratio 0.5 --duration 600

# All long-poll
pnpm start -- --clients 50 --streams 1 --sse-ratio 0

# Against a deployed core (single process, no edge cache)
pnpm start -- --url https://your-core.workers.dev \
  --project-id myapp \
  --secret your-signing-secret \
  --clients 1000 --streams 1 --duration 600

# ── Distributed mode (real edge testing) ────────────────────────────

# First, deploy the load test Worker:
pnpm deploy

# Then run:
pnpm start -- \
  --url https://your-core.workers.dev \
  --worker-url https://durable-streams-loadtest.your-account.workers.dev \
  --project-id myapp \
  --secret your-signing-secret \
  --clients 1000 --streams 1 --sse-ratio 0.5 --duration 300
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--url` | *(starts local core)* | Core worker URL. Omit to auto-start a local auth-free test worker. |
| `--worker-url` | *(none)* | Load test Worker URL. When provided, switches to distributed mode. |
| `--project-id` | `loadtest` | Project ID for stream paths (`/v1/{projectId}/stream/...`) |
| `--secret` | *(none)* | Signing secret for JWT auth. Omit when testing against the local auth-free worker. |
| `--clients` | `100` | Total reader connections to hold open |
| `--streams` | `10` | Number of streams to spread clients across |
| `--sse-ratio` | `1.0` | Fraction of clients using SSE vs long-poll (0.0 = all long-poll, 1.0 = all SSE) |
| `--write-interval` | `1000` | Milliseconds between writes to each stream |
| `--duration` | `300` | Test duration in seconds |
| `--ramp-up` | `10` | Seconds to stagger client connections over (local mode only) |
| `--msg-size` | `256` | Approximate message body size in bytes |

## How distributed mode works

1. The **orchestrator** (your machine) creates streams on core and starts writer loops.
2. It fires N concurrent POST requests to the **load test Worker**, each specifying a stream ID, mode (SSE/long-poll), and duration.
3. Each Worker invocation acts as a single reader, connecting to core's **public URL** so requests go through the CDN edge cache.
4. Each Worker tracks x-cache headers, delivery latency, and writes per-batch data points to Analytics Engine.
5. When a Worker finishes (after `durationSec`), it returns a JSON summary.
6. The orchestrator aggregates all summaries and prints the final report.

The key insight: each Worker invocation is a separate edge instance. When 1000 Workers all read the same stream position at the same time, the CDN edge cache collapses them into a single DO round-trip. This is what we're testing.

## Analytics Engine

In distributed mode, each Worker writes per-batch data points to the `loadtest_metrics` Analytics Engine dataset:

| Field | Value |
|-------|-------|
| `blobs[0]` | stream ID |
| `blobs[1]` | mode (`sse` / `long-poll`) |
| `blobs[2]` | x-cache header value |
| `doubles[0]` | batch size (items) |
| `doubles[1]` | delivery latency (ms) |
| `indexes[0]` | `loadtest` |

Query with Workers Analytics Engine SQL API after a run for detailed analysis.

## What it measures

- **Write throughput**: operations/sec, latency percentiles (p50/p90/p99/max)
- **SSE delivery**: batch count, errors per connection
- **Long-poll delivery**: batch count, errors per connection
- **Event delivery latency**: time from write to receipt across all readers (p50/p90/p99/max)
- **x-cache headers**: distribution of cache HIT/MISS/DYNAMIC across all fetch calls

## Files

| File | Purpose |
|------|---------|
| `src/run.ts` | Node CLI orchestrator. Local mode (N in-process connections) or distributed mode (fires N requests to Worker). |
| `src/worker.ts` | Cloudflare Worker. Accepts POST with config, runs one reader connection, returns JSON summary. |
| `src/metrics.ts` | Latency histogram with reservoir sampling (10k samples), x-cache tracking, delivery stats. Used by local mode. |
| `src/jwt.ts` | HS256 JWT signer for authenticating against deployed core. |
| `wrangler.toml` | Worker config with Analytics Engine binding. |
