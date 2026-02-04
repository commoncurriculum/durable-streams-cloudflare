# durable-streams

Durable Streams implementation workspace.

## What’s Here
- `packages/durable-stream-server/` — Cloudflare Worker + Durable Object + D1 + R2 implementation.
- `docs/cloudflare-refactor-plan.md` — Refactor plan and progress notes for the Cloudflare server.
- `docs/cloudflare-architecture.md` — Module and data-flow overview for the Cloudflare server.

## Cloudflare Server (quick start)
```bash
cd packages/durable-stream-server
pnpm install
pnpm run dev
```

Run conformance (requires `pnpm run dev` in another shell):
```bash
cd packages/durable-stream-server
pnpm run conformance
```
