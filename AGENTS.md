# Agent Development Guidelines

## What This Repo Is

Durable Streams on Cloudflare — a port of the [Durable Streams](https://github.com/electric-sql/durable-streams) protocol to Cloudflare Workers + Durable Objects, plus a pub/sub subscription layer on top.

Two independent Workers that deploy separately. Subscription depends on core, but core works standalone.

## Packages

| Package | What |
|---------|------|
| `packages/core` | Durable Streams protocol. One DO per stream, SQLite hot log, R2 cold segments. |
| `packages/subscription` | Pub/sub fan-out. Sessions, fan-out, TTL cleanup, Analytics Engine metrics. |
| `packages/admin-core` | Admin dashboard for core. |
| `packages/admin-subscription` | Admin dashboard for subscription. |
| `packages/docs` | Slidev presentations. |

Each package has its own `README.md`, `package.json`, `wrangler.toml`, and vitest configs. **Read those directly** — don't rely on this file for their contents.

## Where to Find Things

- **Architecture**: `docs/cloudflare-architecture.md` has the core module map, data model, and request flow
- **CDN caching**: `docs/cdn-cache-flow.md`
- **Design docs**: everything in `docs/` is internal design notes
- **API endpoints**: each package README documents its routes
- **Auth patterns**: each package README has auth examples
- **Env vars and wrangler bindings**: each package's `wrangler.toml` and README
- **CI**: `.github/workflows/ci.yml`

## Tech Stack

- **Runtime**: Cloudflare Workers + Durable Objects (SQLite) + R2 + Analytics Engine
- **HTTP**: Hono v4 + Zod v3 + `@hono/zod-validator` (core + subscription workers)
- **Admin dashboards**: TanStack Start + TanStack Query + Recharts + Tailwind CSS v4, deployed via @cloudflare/vite-plugin
- **Build**: TypeScript strict via `tsc` (shared `tsconfig.build.json` at root)
- **Test**: Vitest. Core has 4 vitest configs (unit, implementation, conformance, performance). Subscription has 2 (unit, integration). Integration tests use wrangler `unstable_dev`.
- **Lint/Format**: oxlint + oxfmt (NOT ESLint/Prettier)
- **Package Manager**: pnpm (see `packageManager` in root `package.json` for exact version)

## Key Conventions

- Core and subscription workers follow the same pattern: `createXWorker()` factory + exported DO class. Entry point is always `src/http/worker.ts`.
- Admin dashboards are TanStack Start apps: `src/server.ts` entry, file-based routing in `src/routes/`, server functions in `src/lib/analytics.ts`, TanStack Query hooks in `src/lib/queries.ts`.
- `pnpm dev` at root runs all 4 workers in parallel with unique ports.

## Admin Dashboards (admin-core + admin-subscription)

Both admin packages are **TanStack Start** apps on Cloudflare Workers. They share the same architecture — read one and you understand both. Start from `wrangler.toml` for bindings, `src/routes/` for pages, `src/lib/analytics.ts` for server functions.

### How It Works

- **Server functions** use `createServerFn` and access Cloudflare bindings via `import { env } from "cloudflare:workers"`. They call backend workers through service bindings (see each package's `wrangler.toml` for binding names).
- **Route loaders** fetch data server-side so it appears in the SSR HTML. Without a loader, `useQuery` only runs client-side and SSR renders a loading skeleton. If a plain `fetch` to the page should return real data, that page needs a loader.
- **`useQuery` with `refetchInterval`** handles client-side polling for pages where a skeleton on first paint is fine (e.g., overview dashboards).
- **Parent routes** with child routes must render `<Outlet />` or children won't appear.

### Gotchas

- `router.tsx` must export `getRouter` (not `createRouter`) — TanStack Start's server handler expects this exact name.
- `cloudflare:workers` is not available in vitest. You cannot import any source file that transitively touches it. Tests that need to check source files read them as strings.
- Integration tests build with `vite build` then run the built output via `wrangler dev --local --config dist/server/wrangler.json`. Always rebuild before running them.
- The `@cloudflare/vite-plugin` inspector port is set via `CF_INSPECTOR_PORT` env var in `vite.config.ts` to avoid conflicts when running multiple workers.

## Testing

- **Gotcha**: Core's `pnpm test` runs implementation tests (live wrangler workers), NOT unit tests. Use `pnpm test:unit` explicitly for pure function tests.
- Integration tests (core implementation + subscription integration) start real wrangler workers via `global-setup.ts` files in the test directories.

## Documentation Regions (subscription only)

Subscription source files have `// #region synced-to-docs:<name>` markers referenced by `packages/subscription/docs/walkthrough.md` (Slidev). When refactoring:

- Moving code within a file: markers move automatically, no action needed.
- Moving code to a different file: **move the region markers with it**.
- Deleting code with markers: remove markers AND the `<<<` reference in the walkthrough.

To find all current regions: `grep -r "synced-to-docs:" packages/subscription/src`
