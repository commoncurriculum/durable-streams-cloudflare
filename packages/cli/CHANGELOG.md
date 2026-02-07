# @durable-streams-cloudflare/cli

## 0.2.0

### Minor Changes

- Add KV namespace creation and PROJECT_KEYS bindings to CLI setup wizard. The setup command now creates a KV namespace before scaffolding wrangler.toml files, and all four template functions include the PROJECT_KEYS binding. The create-project command auto-detects the namespace ID from the scaffolded wrangler.toml.
