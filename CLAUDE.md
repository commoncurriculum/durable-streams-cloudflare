# Claude Development Guidelines

## Repository Structure

This is a monorepo containing the `subscription` package (Cloudflare Workers + Durable Objects) and the upstream `durable-streams` project.

- `packages/subscription/` — Subscription service (Workers, DOs, Analytics Engine)
- `upstream/` — Core durable-streams protocol implementation (see `upstream/CLAUDE.md`)

## Documentation Regions (packages/subscription)

The subscription package has a Slidev walkthrough at `packages/subscription/docs/walkthrough.md` that embeds code snippets from source files using named `#region` markers.

### How it works

Source files use `// #region synced-to-docs:<name>` and `// #endregion synced-to-docs:<name>` comments to mark code sections. The `synced-to-docs:` prefix signals that these markers are referenced by documentation and must not be moved or removed without updating the walkthrough. The walkthrough references them with `<<< @/../src/path/to/file.ts#synced-to-docs:region-name ts`, and Slidev renders only the code between the markers (the markers themselves are hidden).

### Why this matters

The walkthrough previously used line-number ranges (`#L1-L25`) which broke on every refactor. Named regions survive line shifts — but only if you **move the region markers with the code they wrap**.

### When refactoring subscription source files

If you add, remove, or move code inside a region, no action needed — the markers move with the code automatically.

If you move a function or block to a different file, **move its `#region synced-to-docs:`/`#endregion synced-to-docs:` markers too**. If you delete code that has regions, remove the markers and the corresponding `<<<` reference in the walkthrough.

### Current regions

| Region | File | Walkthrough slide |
|--------|------|-------------------|
| `synced-to-docs:worker-entry` | `src/http/create_worker.ts` | The Worker Entry Point |
| `synced-to-docs:middleware` | `src/http/create_worker.ts` | Middleware Stack |
| `synced-to-docs:scheduled-handler` | `src/http/create_worker.ts` | Scheduled Handler |
| `synced-to-docs:subscribe-schema` | `src/http/routes/subscribe.ts` | Subscribe Route (Schema + Validation) |
| `synced-to-docs:create-session-stream` | `src/subscriptions/subscribe.ts` | Creating the Session Stream in Core |
| `synced-to-docs:add-subscription-to-do` | `src/subscriptions/subscribe.ts` | Adding Subscription to SubscriptionDO |
| `synced-to-docs:subscribe-response` | `src/subscriptions/subscribe.ts` | The Response |
| `synced-to-docs:do-overview` | `src/subscriptions/do.ts` | SubscriptionDO Overview |
| `synced-to-docs:add-subscriber` | `src/subscriptions/do.ts` | Adding a Subscriber |
| `synced-to-docs:get-subscribers` | `src/subscriptions/do.ts` | Getting Subscribers |
| `synced-to-docs:publish-to-source` | `src/subscriptions/do.ts` | Write to Source Stream |
| `synced-to-docs:fanout` | `src/subscriptions/do.ts` | Fanout |
| `synced-to-docs:stale-cleanup` | `src/subscriptions/do.ts` | Stale Subscriber Cleanup (nested inside `fanout`) |
| `synced-to-docs:publish-response` | `src/subscriptions/do.ts` | Response with Fanout Headers |
| `synced-to-docs:unsubscribe` | `src/subscriptions/unsubscribe.ts` | Unsubscribe Flow |
| `synced-to-docs:get-session` | `src/session/index.ts` | Session Info |
| `synced-to-docs:touch-session` | `src/session/index.ts` | Touch (Extend TTL) |
| `synced-to-docs:publish-route` | `src/http/routes/publish.ts` | The Publish Route |
| `synced-to-docs:cleanup-overview` | `src/cleanup/index.ts` | Session Cleanup Overview |
| `synced-to-docs:cleanup-session` | `src/cleanup/index.ts` | Removing Subscriptions + Deleting Streams |
| `synced-to-docs:cleanup-main` | `src/cleanup/index.ts` | Cleanup Implementation |
| `synced-to-docs:id-patterns` | `src/constants.ts` | Input Validation |
| `synced-to-docs:fetch-from-core` | `src/client.ts` | Core Client |
| `synced-to-docs:metrics-overview` | `src/metrics/index.ts` | Metrics Overview |
| `synced-to-docs:metrics-fanout-subscription` | `src/metrics/index.ts` | Metrics: Fanout & Subscription |
| `synced-to-docs:metrics-session-cleanup` | `src/metrics/index.ts` | Metrics: Session Lifecycle & Cleanup |
