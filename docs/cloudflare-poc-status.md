# Cloudflare POC Status

## Baseline (2026-02-03)
- Conformance suite: **pending** (re-run after refactor).
- Implementation tests: **pending** (re-run after refactor).
- Perf smoke: **pending** (re-run after refactor).

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
If `PERF_BASE_URL` is set, the test enforces the budget by default. Set
`PERF_BUDGET_MS=10` and `PERF_ENFORCE=1` to override locally.

## Notes
- Local R2 is enabled via `wrangler dev --local`.
- DO SQLite initializes schema on first request.
- R2 segments are used for catch-up reads when available.
- Segment rotation runs opportunistically on writes and flushes the tail on close.
