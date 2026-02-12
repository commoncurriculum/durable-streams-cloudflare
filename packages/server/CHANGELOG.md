# @durable-streams-cloudflare/server

## 0.8.0

### Features

- **Edge cache collapsing**: Concurrent reads at the same stream position now collapse into a single Durable Object round-trip via CDN-native caching, DO pre-cache, and edge pre-warming — dramatically improving fan-out read performance
- **Per-stream CDN reader keys**: Authorize cached reads with dedicated per-stream keys
- **Per-project CORS origins**: Configure allowed origins per-project via KV
- **Signing key rotation**: Rotate project signing secrets without downtime
- **`Stream-Write-Timestamp` header**: All read responses now include the timestamp of the last write

### Breaking Changes

- **Subscription headers renamed**: `X-Fanout-*` → `Stream-Fanout-*`, `X-Stream-*` → `Stream-*` to align with core conventions
- **Default content-type is now `application/octet-stream`**: Streams created without an explicit content-type default to `application/octet-stream`

### Fixes

- **Subscription cleanup uses DO alarms** instead of cron for more reliable session lifecycle management
- **Session discovery** now uses SessionDO RPC instead of Analytics Engine
- **Bounded in-flight maps** to prevent unbounded memory growth under load
- **Error messages surfaced** in all catch blocks instead of swallowing details
- Security hardening from unified security review

## 0.7.0

### Minor Changes

- Include source files in published npm packages for build-from-source deployments. Add created_at timestamp to read chunks.

## 0.6.0

### Minor Changes

- Add X-Cache response header for edge cache observability and scaffold new projects as pnpm workspaces

## 0.5.0

### Minor Changes

- Add X-Cache response header for edge cache observability and scaffold new projects as pnpm workspaces

## 0.4.0

### Minor Changes

- Add edge cache for read request collapsing via Cache API, internal WebSocket bridge for DO hibernation on SSE reads, security and protocol conformance fixes

## 0.3.7

## 0.3.6

## 0.3.5

## 0.3.4

## 0.3.3

## 0.3.2

## 0.3.1

## 0.3.0

## 0.2.3

## 0.2.2

## 0.2.1

## 0.2.0
