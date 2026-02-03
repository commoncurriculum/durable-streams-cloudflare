# Cloudflare POC Status

## Baseline (2026-02-03)
- Conformance suite: **239/239** (local `wrangler dev --local`).
- Implementation tests: **7/7** (local worker, real D1/R2).

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
```
`pnpm run test:implementation` will start a local worker automatically if
`IMPLEMENTATION_TEST_URL` is not set.

## Notes
- Local R2 is enabled via `wrangler dev --local`.
- D1 migrations are idempotent; re-running may fail on existing columns.
