# Agent Development Guidelines

## What This Repo Is

Durable Streams on Cloudflare — a port of the [Durable Streams](https://github.com/electric-sql/durable-streams) protocol to Cloudflare Workers + Durable Objects, plus a pub/sub subscription layer on top.

Single unified Worker with all functionality.

## Packages

| Package           | What                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server` | Durable Streams protocol + pub/sub fan-out. One DO per stream, SQLite hot log, R2 cold segments, subscriptions, sessions, TTL cleanup, Analytics Engine metrics. |
| `packages/docs`   | Slidev presentations.                                                                                                                                            |
| `packages/cli`    | Setup wizard and project management.                                                                                                                             |

Each package has its own `README.md`, `package.json`, `wrangler.toml`, and vitest configs. **Read those directly** — don't rely on this file for their contents.

## Where to Find Things

- **Architecture**: `packages/server/call-graph.md` — request flow diagrams, DO communication patterns
- **API endpoints**: `packages/server/README.md` documents all routes
- **Code organization**: `packages/server/src/http/v1/streams/` — all stream operations
- **Auth patterns**: each package README has auth examples
- **Env vars and wrangler bindings**: each package's `wrangler.toml` and README
- **CI**: `.github/workflows/ci.yml`

## Tech Stack

- **Runtime**: Cloudflare Workers + Durable Objects (SQLite) + R2 + Analytics Engine
- **HTTP**: Hono v4 + ArkType v2 + `@hono/arktype-validator`
- **Build**: TypeScript strict via `tsc` (shared `tsconfig.build.json` at root)
- **Test**: Vitest. Server has 3 vitest configs (unit, integration, conformance). Integration tests use wrangler `unstable_dev`.
- **Lint/Format**: oxlint + oxfmt (NOT ESLint/Prettier)
- **Package Manager**: pnpm (see `packageManager` in root `package.json` for exact version)

## Critical Design Constraints

- **Edge request collapsing is a CORE design goal.** The entire point of the edge cache layer (`caches.default` in the edge worker) is to collapse concurrent reads at the same stream position into a single DO round-trip. Without this, the system cannot scale fan-out reads — 1M followers of a stream means 1M hits to the Durable Object, which is unacceptable. Any change to the edge cache must preserve (or improve) collapsing for live tail long-poll reads.

## Key Conventions

- Server worker pattern: `createStreamWorker()` factory in `src/http/router.ts` + DO classes in `src/http/v1/streams/index.ts` (StreamDO), `src/subscriptions/do.ts` (SubscriptionDO), `src/estuary/do.ts` (EstuaryDO). Entry point is `src/http/worker.ts`.
- Edge worker (`router.ts`) handles: auth, CORS, edge caching, routing to correct DO
- DOs handle: all state mutations, SQLite operations, broadcasts, serialization via `blockConcurrencyWhile`

## Testing

- **Server tests**: `pnpm -C packages/server test` runs integration tests. Use `pnpm test:unit` for pure function tests, `pnpm conformance` for protocol conformance.
- Integration tests start real wrangler workers via `global-setup.ts` files in test directories.
- **Cloudflare Vitest integration**: Use `@cloudflare/vitest-pool-workers` for tests that need Cloudflare runtime APIs (DurableObject, WorkerEntrypoint, bindings, etc.) without mocking. Docs: https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
- **Miniflare**: Local simulator for Workers runtime, used under the hood by `wrangler dev` and `@cloudflare/vitest-pool-workers`. Docs: https://developers.cloudflare.com/workers/testing/miniflare/

### Test Patterns

**Unit tests** should use `worker.app.request()` per [Hono testing docs](https://hono.dev/docs/guides/testing):

```typescript
const response = await worker.app.request(
  "/v1/stream/test",
  { method: "PUT", headers: { "Content-Type": "text/plain" } },
  env,
);
```

**Note**: Some existing unit tests use the older `worker.fetch!()` pattern. See `REFACTOR_TESTS_PROMPT.md` for refactoring these to the cleaner `app.request()` pattern.

**Integration tests** use `fetch` with helper utilities from `test/implementation/helpers.ts`:

```typescript
const client = createClient();
const streamId = uniqueStreamId("test");
await client.createStream(streamId, "", "text/plain");
const response = await fetch(client.streamUrl(streamId));
```

### Coverage

**Current Overall Coverage: 80.14% lines** (1849/2307 lines covered)

For complete coverage documentation, see **`packages/server/COVERAGE.md`**.

**Quick reference:**

```bash
# 1. ALWAYS run fresh coverage first (60-90 seconds)
pnpm -C packages/server cov

# 2. Show uncovered lines
pnpm -C packages/server run coverage:lines

# 3. Filter by area
pnpm -C packages/server run coverage:lines -- estuary

# 4. Show 0% coverage files
pnpm -C packages/server run coverage:lines -- --zero
```

**⚠️ CRITICAL**: Coverage files can be STALE (hours or days old). ALWAYS run `pnpm -C packages/server cov` before checking coverage. See `packages/server/COVERAGE.md` for details.

### Common Test Pitfalls

- **Content-type mismatch (409)**: Server validates that append content-type matches the stream's content-type. When creating streams in tests, the default content-type is `application/json`. If the test then publishes with `text/plain`, server returns 409. Fix: pass matching content-type when creating the stream.
- **Mocks — use sparingly, only for failure paths**: `@cloudflare/vitest-pool-workers` provides real Cloudflare bindings — prefer them over mocks. Mocks are acceptable only when the real binding cannot produce the needed condition:
  - `STREAMS.appendToStream` mocked to throw — simulates server errors that can't be triggered from a test.
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

## API Client Generation

The `packages/estuary-client` package contains an auto-generated TypeScript client (with React Query hooks) built from the server's OpenAPI spec using [Orval](https://orval.dev/).

To regenerate after changing any API routes:

```bash
pnpm -C packages/server run generate-client
```

This runs two steps: (1) regenerates `packages/server/openapi.json` from the Hono routes, then (2) runs Orval to produce `packages/estuary-client/src/generated/client.ts`. No manual edits to generated files — just re-run the script.

## Pre-Push Checklist (CI Parity)

**Before declaring work complete, you MUST run every command below and confirm they all pass.** These are the exact checks GitHub Actions runs on every push and PR. A failure in any of them will block the PR.

**Do NOT use `pnpm -C`** — use `pnpm run` from the repo root instead. Each `-C` invocation triggers a separate user approval prompt.

### 1. Typecheck (all packages)

```sh
pnpm -r run typecheck
```

Runs `tsc --noEmit` in every package that has a `typecheck` script.

### 2. Format check (all packages)

```sh
pnpm -r run format:check
```

Runs `oxfmt --check` in every package with source code. Fails if any file needs formatting. To auto-fix: `pnpm -r run format`

### 3. Lint (all packages)

```sh
pnpm -r run lint
```

Runs `oxlint src test` (or `oxlint src` for packages without tests). Fix all errors **and** warnings — CI treats warnings as informational today but errors are fatal.

### 4. Tests (all packages)

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

Run all CI checks:

```sh
pnpm -r run typecheck
pnpm -C packages/server run lint
pnpm -C packages/server run test:unit
pnpm -C packages/server run conformance
pnpm -C packages/server run test
```

### What the `test` Script Runs

| Package           | `pnpm test` runs                 | Config             |
| ----------------- | -------------------------------- | ------------------ |
| `packages/server` | Integration tests (live workers) | `vitest.config.ts` |

## Test Refactoring Task

**TODO**: Existing unit tests use verbose `worker.fetch!()` pattern. Should be refactored to clean `worker.app.request()` pattern per Hono docs.

See `REFACTOR_TESTS_PROMPT.md` for full instructions or `REFACTOR_TESTS_SHORT.md` for quick reference.
