# @durable-streams-cloudflare/cli

## 0.3.10

### Patch Changes

- [`c581e5d`](https://github.com/commoncurriculum/durable-streams-cloudflare/commit/c581e5dfcf7a48aba6c0b6b0bbafb545c03c3d54) Thanks [@scottmessinger](https://github.com/scottmessinger)! - Add ESModule rules to admin wrangler.toml templates so wrangler uploads asset JS files, add version to CLI header

## 0.3.7

### Patch Changes

- Fix admin package resolution: use exported ./worker path instead of ./package.json

## 0.3.6

### Patch Changes

- Use require.resolve to find admin package paths through pnpm symlinks before copying dist files

## 0.3.5

### Patch Changes

- Copy admin dist files into worker directories instead of referencing through node_modules symlinks

## 0.3.4

### Patch Changes

- Install admin packages in their own worker directories so wrangler can find them

## 0.3.3

### Patch Changes

- Fix admin wrangler.toml paths to resolve node_modules from project root

## 0.3.2

### Patch Changes

- Fix KV namespace ID auto-detection (check stderr), extract magic strings into constants, show R2 bucket name in output

## 0.3.1

### Patch Changes

- Fix API token instructions: permission is "Account Analytics", not "Analytics Engine"

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
