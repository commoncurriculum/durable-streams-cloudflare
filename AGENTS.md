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

- **Design docs**: `docs/00-index.md` is the table of contents for all design documentation (12 chapters)
- **Architecture**: `docs/01-architecture.md` — core module map, data model, request flow
- **Cost analysis**: `docs/02-cost-analysis.md` — billing model, cost-driven design decisions
- **CDN caching**: `docs/05-cache-architecture.md` (current design), `docs/04-cache-evolution.md` (history)
- **Request collapsing**: `docs/06-request-collapsing.md` — sentinel coalescing, loadtest results
- **CDN investigation**: `docs/07-cdn-miss-investigation.md` — production CDN testing, nginx IPv6 fix
- **Subscription design**: `docs/09-subscription-design.md` — hot push / cold catch-up
- **API endpoints**: each package README documents its routes
- **Auth patterns**: each package README has auth examples
- **Env vars and wrangler bindings**: each package's `wrangler.toml` and README
- **CI**: `.github/workflows/ci.yml`

## Tech Stack

- **Runtime**: Cloudflare Workers + Durable Objects (SQLite) + R2 + Analytics Engine
- **HTTP**: Hono v4 + ArkType v2 + `@hono/arktype-validator` (core + subscription workers)
- **Admin dashboards**: TanStack Start + TanStack Query + Recharts + Tailwind CSS v4, deployed via @cloudflare/vite-plugin
- **Build**: TypeScript strict via `tsc` (shared `tsconfig.build.json` at root)
- **Test**: Vitest. Core has 4 vitest configs (unit, implementation, conformance, performance). Subscription has 2 (unit, integration). Integration tests use wrangler `unstable_dev`.
- **Lint/Format**: oxlint + oxfmt (NOT ESLint/Prettier)
- **Package Manager**: pnpm (see `packageManager` in root `package.json` for exact version)

## Critical Design Constraints

- **Edge request collapsing is a CORE design goal.** The entire point of the edge cache layer (`caches.default` in `create_worker.ts`) is to collapse concurrent reads at the same stream position into a single DO round-trip. Without this, the system cannot scale fan-out reads — 1M followers of a stream means 1M hits to the Durable Object, which is unacceptable. Any change to the edge cache must preserve (or improve) collapsing for live tail long-poll reads. See `docs/06-request-collapsing.md` for the full design and `docs/07-cdn-miss-investigation.md` for production CDN testing results.

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
- **Cloudflare Vitest integration**: Use `@cloudflare/vitest-pool-workers` for tests that need Cloudflare runtime APIs (DurableObject, WorkerEntrypoint, bindings, etc.) without mocking. Docs: https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
- **Miniflare**: Local simulator for Workers runtime, used under the hood by `wrangler dev` and `@cloudflare/vitest-pool-workers`. Docs: https://developers.cloudflare.com/workers/testing/miniflare/

### Common Test Pitfalls

- **Content-type mismatch (409)**: Core validates that append content-type matches the stream's content-type. When creating streams in tests with `env.CORE.putStream(key)`, the default content-type is `application/json`. If the test then publishes with `text/plain`, core returns 409. Fix: pass `{ contentType: "text/plain" }` to `putStream` to match whatever the test sends.
- **Mocks — use sparingly, only for failure paths**: `@cloudflare/vitest-pool-workers` provides real Cloudflare bindings — prefer them over mocks. Mocks are acceptable only when the real binding cannot produce the needed condition:
  - `CORE.postStream`/`CORE.deleteStream` mocked to return `{ ok: false, status: 500 }` — simulates core server errors that can't be triggered from a test.
  - `CORE.headStream` mocked to return `{ ok: false, status: 404 }` — simulates a session whose backing stream was deleted externally.
  - `REGISTRY.get` mocked to return specific JSON — controls JWT signing secrets for auth tests.
  - `REGISTRY` removed from env entirely — tests the "misconfigured deployment" 500 path.
  - `env.METRICS.writeDataPoint` mocked — Analytics Engine is unavailable in vitest pool workers.
  - If a condition can be triggered naturally (e.g., 404 from a nonexistent stream, 409 from content-type mismatch), do NOT mock — use the real binding.
- **`Promise.allSettled` swallows rejections**: Fanout uses `Promise.allSettled`, so mocking an RPC to reject won't trigger catch blocks. To test error-handling paths inside `allSettled`, cause the error before the settled call (e.g., invalid base64 payload that throws during decode).

## Validation (ArkType)

Both core and subscription use [ArkType v2](https://arktype.io/) for schema validation at boundaries, with [`arkregex`](https://github.com/arktypeio/arktype/tree/main/ark/arkregex) for type-safe regex patterns.

- **JIT compilation**: ArkType uses `new Function()` for compiled validators. Cloudflare Workers allows `eval()` during startup by default. Define all schemas at **module top-level** so compilation happens during Worker startup.
- **Pipe error pattern**: Use `(value, ctx) => ctx.error("message")` in pipe callbacks. Do NOT use `type.errors("message")` — `ArkErrors` is a class and cannot be called without `new`.
- **Checking for errors**: Use `result instanceof type.errors` (not `=== undefined` or truthiness checks).
- **arkregex**: Use `regex("pattern", "flags")` from `arkregex` instead of raw `RegExp` literals for patterns used in validation. Provides typed capture groups.

## Pre-Push Checklist (CI Parity)

**Before declaring work complete, you MUST run every command below and confirm they all pass.** These are the exact checks GitHub Actions runs on every push and PR. A failure in any of them will block the PR.

**Do NOT use `pnpm -C`** — use `pnpm run` from the repo root instead. Each `-C` invocation triggers a separate user approval prompt.

### 1. Typecheck (all packages)

```sh
pnpm -r run typecheck
```

Runs `tsc --noEmit` in every package that has a `typecheck` script (core, subscription, admin-core, admin-subscription, cli).

### 2. Lint (core + subscription)

```sh
pnpm -C packages/core run lint
pnpm -C packages/subscription run lint
```

Runs `oxlint src test` in each package. Fix all errors **and** warnings — CI treats warnings as informational today but errors are fatal.

### 3. Tests (all packages)

```sh
pnpm -r run test
```

This runs each package's default `test` script:
- **core**: runs implementation tests (live wrangler workers via `vitest.implementation.config.ts`)
- **subscription**: runs unit tests via `@cloudflare/vitest-pool-workers` (excludes `test/integration/`)
- **admin-core**: runs vitest integration tests (builds with vite, starts core + admin workers) **then** Playwright browser tests (chromium). Requires `playwright install chromium` first.
- **admin-subscription**: runs smoke/integration tests

### 4. Core unit tests

```sh
pnpm -C packages/core run test:unit
```

Pure function tests (`test/unit/**/*.test.ts`). Fast, no wrangler needed.

### 5. Conformance tests

```sh
pnpm -C packages/core run conformance
```

Runs the `@durable-streams/server-conformance-tests` suite against a live core worker. The worker is started automatically via `test/conformance/global-setup.ts`.

### 6. Subscription integration tests

```sh
pnpm -C packages/subscription run test:integration
```

Starts both core and subscription workers, then runs `test/integration/**/*.test.ts`. Workers are started automatically via `test/integration/global-setup.ts`.

### Quick Copy-Paste

Run all 6 CI checks sequentially (stop on first failure):

```sh
pnpm test:all
```

This runs: typecheck → lint → core unit tests → conformance → all package tests (including Playwright browser tests) → subscription integration.

### What Each Package's `test` Script Actually Runs

| Package | `pnpm test` runs | Config |
|---------|-------------------|--------|
| `packages/core` | Implementation tests (live workers) | `vitest.implementation.config.ts` |
| `packages/subscription` | Unit tests (miniflare pool) | `vitest.config.ts` (excludes `test/integration/`) |
| `packages/admin-core` | Vitest integration + Playwright browser tests | `vitest.config.ts` + `playwright.config.ts` |
| `packages/admin-subscription` | Smoke tests | `vitest.config.ts` |

## Documentation Regions (subscription only)

Subscription source files have `// #region synced-to-docs:<name>` markers referenced by `packages/subscription/docs/walkthrough.md` (Slidev). When refactoring:

- Moving code within a file: markers move automatically, no action needed.
- Moving code to a different file: **move the region markers with it**.
- Deleting code with markers: remove markers AND the `<<<` reference in the walkthrough.

To find all current regions: `grep -r "synced-to-docs:" packages/subscription/src`
