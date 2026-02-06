# Claude Development Guidelines

## Repository Structure

This is a monorepo containing the `subscription` package (Cloudflare Workers + Durable Objects) and the upstream `durable-streams` project.

- `packages/subscription/` — Subscription service (Workers, DOs, Analytics Engine)
- `upstream/` — Core durable-streams protocol implementation (see `upstream/CLAUDE.md`)

## Documentation Regions (packages/subscription)

The subscription package has a Slidev walkthrough at `packages/subscription/docs/walkthrough.md` that embeds code snippets from source files using named `#region` markers.

### How it works

Source files use `// #region <name>` and `// #endregion <name>` comments to mark code sections. The walkthrough references them with `<<< @/../src/path/to/file.ts#region-name ts`, and Slidev renders only the code between the markers (the markers themselves are hidden).

### Why this matters

The walkthrough previously used line-number ranges (`#L1-L25`) which broke on every refactor. Named regions survive line shifts — but only if you **move the region markers with the code they wrap**.

### When refactoring subscription source files

If you add, remove, or move code inside a region, no action needed — the markers move with the code automatically.

If you move a function or block to a different file, **move its `#region`/`#endregion` markers too**. If you delete code that has regions, remove the markers and the corresponding `<<<` reference in the walkthrough.

### Current regions

| Region | File | Walkthrough slide |
|--------|------|-------------------|
| `worker-entry` | `src/http/create_worker.ts` | The Worker Entry Point |
| `middleware` | `src/http/create_worker.ts` | Middleware Stack |
| `scheduled-handler` | `src/http/create_worker.ts` | Scheduled Handler |
| `subscribe-schema` | `src/http/routes/subscribe.ts` | Subscribe Route (Schema + Validation) |
| `create-session-stream` | `src/subscriptions/subscribe.ts` | Creating the Session Stream in Core |
| `add-subscription-to-do` | `src/subscriptions/subscribe.ts` | Adding Subscription to SubscriptionDO |
| `subscribe-response` | `src/subscriptions/subscribe.ts` | The Response |
| `do-overview` | `src/subscriptions/do.ts` | SubscriptionDO Overview |
| `add-subscriber` | `src/subscriptions/do.ts` | Adding a Subscriber |
| `get-subscribers` | `src/subscriptions/do.ts` | Getting Subscribers |
| `publish-to-source` | `src/subscriptions/do.ts` | Write to Source Stream |
| `fanout` | `src/subscriptions/do.ts` | Fanout |
| `stale-cleanup` | `src/subscriptions/do.ts` | Stale Subscriber Cleanup (nested inside `fanout`) |
| `publish-response` | `src/subscriptions/do.ts` | Response with Fanout Headers |
| `unsubscribe` | `src/subscriptions/unsubscribe.ts` | Unsubscribe Flow |
| `get-session` | `src/session/index.ts` | Session Info |
| `touch-session` | `src/session/index.ts` | Touch (Extend TTL) |
| `publish-route` | `src/http/routes/publish.ts` | The Publish Route |
| `cleanup-overview` | `src/cleanup/index.ts` | Session Cleanup Overview |
| `cleanup-session` | `src/cleanup/index.ts` | Removing Subscriptions + Deleting Streams |
| `cleanup-main` | `src/cleanup/index.ts` | Cleanup Implementation |
| `id-patterns` | `src/constants.ts` | Input Validation |
| `fetch-from-core` | `src/client.ts` | Core Client |
| `metrics-overview` | `src/metrics/index.ts` | Metrics Overview |
| `metrics-fanout-subscription` | `src/metrics/index.ts` | Metrics: Fanout & Subscription |
| `metrics-session-cleanup` | `src/metrics/index.ts` | Metrics: Session Lifecycle & Cleanup |
