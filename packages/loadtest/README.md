# @durable-streams-cloudflare/loadtest

Load test tool for the core durable-streams worker.

---

## ⚠️ CDN CACHE HIT RATES FROM DISTRIBUTED MODE ARE NOT PRODUCTION-REPRESENTATIVE ⚠️

**Distributed mode uses Cloudflare Worker subrequests (`fetch()` from a CF Worker to a CF CDN URL). These subrequests do NOT participate in CDN request coalescing the same way external HTTP requests do.**

In production, real clients (browsers, mobile apps, `curl`, any external HTTP client) hit the CDN and get **99%+ cache HIT rates** — Cloudflare coalesces concurrent requests for the same cache key into a single origin request. This is the designed behavior and it works.

In the distributed loadtest, each reader is a CF Worker isolate calling `fetch()`. The CDN does NOT coalesce these subrequests. Instead, each new cache key generates **~10 CDN MISSes** (instead of 1), producing HIT rates of 78-83%. This is a property of Cloudflare's internal Worker-to-CDN path, not a bug in the service.

### What this means

| Metric | Distributed loadtest | Production (real clients) |
|--------|---------------------|--------------------------|
| CDN HIT rate | 78-83% | 99%+ |
| MISSes per cache key | ~10 | 1 |
| Delivery latency | Accurate | Accurate |
| Write throughput | Accurate | Accurate |
| Error rates | Accurate | Accurate |

### How to get production-representative CDN numbers

Run `diagnose-cdn.ts` from **any machine that is NOT a Cloudflare Worker** — your laptop, a cloud VM, a Digital Ocean droplet, etc. It fires concurrent requests as an external HTTP client, which exercises the real CDN coalescing path.

```sh
# From any external machine (laptop, VM, droplet):
npx tsx src/diagnose-cdn.ts \
  --url https://ds-stream.commonplanner.com \
  --project-id loadtest --secret YOUR_SECRET \
  --concurrency 50

# Result: 1 MISS + 49 HIT (98%+ HIT rate)
# Even at 250 concurrency: 1 MISS + 249 HIT (99.6%)
```

To run at scale from an external server, copy the loadtest package to a cloud VM:
```sh
# Example: Digital Ocean droplet
scp -r packages/loadtest root@YOUR_DROPLET:/root/loadtest
ssh root@YOUR_DROPLET "cd /root/loadtest && npm install && npx tsx src/diagnose-cdn.ts --url ... --concurrency 250"
```

### When to use distributed mode

Distributed mode is still valuable for testing:
- **Delivery latency** (end-to-end from write to reader receipt)
- **Write throughput** and error rates
- **Offset drift** (whether readers stay synchronized)
- **Edge Worker behavior** under load (memory, CPU, timeouts)
- **The full stack** (auth, proxy, DO, long-poll, SSE)

Just **ignore the `CF-CACHE-STATUS` numbers** — they reflect Worker subrequest behavior, not production CDN behavior.

---

Two modes:

- **Local mode**: Single Node.js process holding N concurrent connections. Good for quick dev testing.
- **Distributed mode**: Deploys a load test Worker to Cloudflare. Each reader is a separate Worker invocation at the edge that connects to core's **public URL** via `fetch()`. Useful for testing delivery latency, error rates, and full-stack behavior under load. **CDN cache HIT rates will be lower than production — see warning above.**

Both modes measure write throughput, event delivery latency percentiles, x-cache header distribution, and error rates.

## Architecture

```
Local mode:
  Node process → N concurrent fetch() calls → core worker (local or deployed)

Distributed mode:
  Orchestrator (Node CLI on any machine)
    ├── Creates streams on core (HTTP)
    ├── Writes messages to streams at --write-interval
    └── Fires N POST requests to Load Test Worker
          │
          v
  Load Test Worker (CF Worker isolate)
    ├── Each invocation = 1 reader (SSE or long-poll)
    ├── Calls fetch() to core's PUBLIC URL (CDN-proxied)
    │     ⚠ CF Worker subrequests do NOT coalesce at CDN level!
    │     ⚠ CDN HIT rates will be 78-83%, not the 99%+ that real clients get.
    ├── Tracks cf-cache-status, x-cache, delivery latency, PoP distribution
    ├── Writes data points to Analytics Engine
    └── Returns JSON summary when done
          │
          v
  Core Worker (deployed on Cloudflare)
    └── Edge cache + in-flight coalescing for DO fan-out

diagnose-cdn.ts (for production-representative CDN numbers):
  External machine (laptop, VM, droplet)
    └── fetch() as external HTTP client → CDN coalesces at 99%+
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
4. Each Worker tracks cf-cache-status, x-cache headers, delivery latency, per-offset cache status, CDN PoP distribution, and writes per-batch data points to Analytics Engine.
5. When a Worker finishes (after `durationSec`), it returns a JSON summary.
6. The orchestrator aggregates all summaries and prints the final report.

**Important**: CDN cache HIT rates from distributed mode (~78-83%) are NOT representative of production. Worker `fetch()` subrequests do not coalesce at the CDN level. Real external clients get 99%+ HIT rates. See the warning at the top of this file. Use `diagnose-cdn.ts` from an external machine for production-representative CDN numbers.

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

## CDN diagnostic tool (`diagnose-cdn.ts`)

Tests CDN coalescing from an **external** HTTP client — the only way to get production-representative numbers. Must be run from a machine outside Cloudflare's Worker network (laptop, VM, cloud server).

```sh
# From your machine or a cloud VM:
npx tsx src/diagnose-cdn.ts \
  --url https://ds-stream.commonplanner.com \
  --project-id loadtest --secret YOUR_SECRET \
  --concurrency 50 --rounds 3

# Tests:
#   1. Concurrent mid-stream reads (immutable data, warm cache)
#   2. Concurrent long-poll at tail (write resolves all waiters)
#   3. Staggered long-poll (10ms between each)
#   4. High concurrency (5x the --concurrency value)
```

## Files

| File | Purpose |
|------|---------|
| `src/run.ts` | Node CLI orchestrator. Local mode (N in-process connections) or distributed mode (fires N requests to Worker). |
| `src/worker.ts` | Cloudflare Worker. Accepts POST with config, runs one reader connection, returns JSON summary. |
| `src/diagnose-cdn.ts` | CDN coalescing diagnostic. **Run from external machine** for production-representative CDN HIT rates. |
| `src/metrics.ts` | Latency histogram with reservoir sampling (10k samples), x-cache tracking, delivery stats. Used by local mode. |
| `src/jwt.ts` | HS256 JWT signer for authenticating against deployed core. |
| `wrangler.toml` | Worker config with Analytics Engine binding. |
