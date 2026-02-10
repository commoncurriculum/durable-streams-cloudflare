# @durable-streams-cloudflare/admin-core

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

## 0.6.0

## 0.5.0
