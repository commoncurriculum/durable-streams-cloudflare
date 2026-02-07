# @durable-streams-cloudflare/cli

## 0.3.0

### Minor Changes

- Revamp setup wizard: add project directory choice, confirmation screen with worker names, inline project creation, Zero Trust walkthrough, Git/GitHub setup, and Cloudflare Connect to Git guidance

## 0.2.3

### Patch Changes

- Rename KV binding from PROJECT_KEYS to REGISTRY, fix template literal bugs in resource creation commands

## 0.2.2

### Patch Changes

- Auto-detect wrangler runner (direct, npx, or pnpx) instead of hardcoding npx

## 0.2.1

### Patch Changes

- Fix wrangler detection by using `npx -y` to auto-confirm install prompts in child processes

## 0.2.0

### Minor Changes

- Add KV namespace creation and REGISTRY bindings to CLI setup wizard. The setup command now creates a KV namespace before scaffolding wrangler.toml files, and all four template functions include the REGISTRY binding. The create-project command auto-detects the namespace ID from the scaffolded wrangler.toml.
