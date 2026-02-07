# @durable-streams-cloudflare/cli

Setup wizard and project management CLI for Durable Streams on Cloudflare.

## Usage

```bash
npx @durable-streams-cloudflare/cli <command>
```

### `setup`

Scaffolds a new project, creates Cloudflare resources, and deploys.

```bash
npx @durable-streams-cloudflare/cli setup
```

The wizard walks you through:

1. **Preflight** — checks for wrangler and Cloudflare auth
2. **Component selection** — choose which workers to deploy (core, subscription, admin dashboards)
3. **Cloudflare resources** — creates an R2 bucket and KV namespace
4. **pnpm workspace scaffolding** — generates a workspace with per-worker packages:

```
my-project/
├── package.json            # root workspace (dev/deploy scripts, wrangler)
├── pnpm-workspace.yaml     # declares workers/*
├── pnpm-lock.yaml          # single lockfile
└── workers/
    ├── streams/
    │   ├── package.json    # depends on @durable-streams-cloudflare/core
    │   ├── wrangler.toml
    │   └── src/worker.ts
    ├── subscriptions/
    │   ├── package.json    # depends on @durable-streams-cloudflare/subscription
    │   ├── wrangler.toml
    │   └── src/worker.ts
    ├── admin-core/
    │   ├── package.json    # depends on @durable-streams-cloudflare/admin-core
    │   └── wrangler.toml
    └── admin-subscription/
        ├── package.json    # depends on @durable-streams-cloudflare/admin-subscription
        └── wrangler.toml
```

5. **Install** — single `pnpm install` at root resolves all workspace dependencies
6. **Deploy** — deploys each worker to Cloudflare
7. **First project** — optionally creates a project with a JWT signing secret
8. **Git + GitHub** — optionally initializes a repo and pushes to GitHub

After setup, you can run all workers locally with:

```bash
pnpm dev
```

Or deploy everything with:

```bash
pnpm deploy
```

### `create-project`

Creates a new project with a JWT signing secret in the REGISTRY KV namespace.

```bash
npx @durable-streams-cloudflare/cli create-project
```

This generates (or accepts) a signing secret and writes it to KV. You use this secret to mint JWTs for authenticating API requests.

## Prerequisites

- [pnpm](https://pnpm.io/installation)
- [wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (or it will be invoked via npx)
- Cloudflare account (run `wrangler login` first)

## License

MIT
