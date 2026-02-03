# Cloudflare POC Status

## Baseline (2026-02-03)
- Conformance suite: **pass** (239/239).
- Implementation tests: **pass** (16/16).
- Perf smoke: **pass**.
  - append p50=1.90ms p95=3.24ms
  - read p50=2.18ms p95=3.40ms
  - long-poll (hit) p50=2.70ms p95=3.97ms

## Commands (local)
```bash
cd poc/cloudflare
pnpm install

# Optional: apply admin D1 migrations
pnpm exec wrangler d1 migrations apply durable_streams_admin --local

# Start local worker (DO SQLite + local R2)
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
`pnpm run conformance` will start a local worker automatically unless
`CONFORMANCE_TEST_URL` is set.
If `PERF_BASE_URL` is set, the test enforces the budget by default. Set
`PERF_BUDGET_MS=10` and `PERF_ENFORCE=1` to override locally.

## Notes
- Local R2 is enabled via `wrangler dev --local`.
- DO SQLite initializes schema on first request.
- R2 segments are used for catch-up reads when available.
- Segment rotation runs opportunistically on writes and flushes the tail on close.
