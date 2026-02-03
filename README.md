# durable-streams

Durable Streams implementation workspace.

## What’s Here
- `poc/cloudflare/` — Cloudflare Worker + Durable Object + D1 + R2 proof‑of‑concept implementation.
- `docs/cloudflare-refactor-plan.md` — Refactor plan and progress notes for the Cloudflare POC.

## Cloudflare POC (quick start)
```bash
cd poc/cloudflare
pnpm install
pnpm run dev
```

Run conformance (requires `pnpm run dev` in another shell):
```bash
cd poc/cloudflare
pnpm run conformance
```
