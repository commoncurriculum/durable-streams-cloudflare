# Cloudflare POC Status

## Baseline (2026-02-03)
- Conformance suite: **239/239** (local `wrangler dev --local`).
- Implementation tests: **11/11** (local worker, real D1/R2).
- Perf smoke: append p95 ~7ms, read p95 ~6ms (local dev run; non‑gating).

## Commands (local)
```bash
cd poc/cloudflare
pnpm install

# Apply migrations (local D1)
wrangler d1 execute durable_streams_poc --local --file migrations/0001_init.sql
wrangler d1 execute durable_streams_poc --local --file migrations/0002_expiry_snapshots.sql
wrangler d1 execute durable_streams_poc --local --file migrations/0003_producer_last_updated.sql
wrangler d1 execute durable_streams_poc --local --file migrations/0004_closed_by_producer.sql

# Start local worker (local D1 + local R2)
pnpm run dev
```

## Tests
Run from another shell while `pnpm run dev` is running:
```bash
cd poc/cloudflare
pnpm run conformance
pnpm run test:implementation
pnpm run perf
```
`pnpm run test:implementation` will start a local worker automatically if
`IMPLEMENTATION_TEST_URL` is not set.
`pnpm run perf` will start a local worker automatically unless `PERF_BASE_URL`
is set.
If `PERF_BASE_URL` is set, the test enforces the budget by default. Set
`PERF_BUDGET_MS=10` and `PERF_ENFORCE=1` to override locally.

## Notes
- Local R2 is enabled via `wrangler dev --local`.
- D1 migrations are idempotent; re-running may fail on existing columns.
- R2 segments are used for catch-up reads when available (fallback to D1).
- Compaction runs opportunistically on writes and flushes the tail on close.
