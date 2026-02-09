# CORS Configuration

Per-project CORS origins are stored in the `REGISTRY` KV namespace alongside signing secrets. This replaces the previous `CORS_ORIGINS` environment variable.

## How It Works

Both the core and subscription workers resolve CORS origins from KV on every request:

1. Extract the project ID from the URL path (`/v1/:project/...`).
2. Look up the project config from `REGISTRY` KV.
3. If the config includes `corsOrigins`, use it for CORS headers.
4. If no `corsOrigins` field exists (or no KV entry at all), **no CORS headers are emitted** (secure default).

Non-project routes (`/health`, unknown paths) never emit CORS headers.

## KV Value Format

The `REGISTRY` KV stores per-project config as JSON. The `corsOrigins` field is optional:

```json
{
  "signingSecrets": ["your-secret-here"],
  "corsOrigins": ["https://app.example.com", "https://staging.example.com"]
}
```

### Supported `corsOrigins` Values

| Value | Behavior |
|-------|----------|
| `["*"]` | Allows all origins (`Access-Control-Allow-Origin: *`) |
| `["https://example.com"]` | Allows only the specified origin |
| `["https://a.com", "https://b.com"]` | Allows either origin (returns the matching one) |
| `[]` or omitted | No CORS headers (requests from browsers will be blocked by same-origin policy) |

When multiple origins are configured and the request `Origin` header matches one of them, that origin is returned. If no match, the first configured origin is returned as the default.

## Migration from `CORS_ORIGINS` Environment Variable

The `CORS_ORIGINS` env var has been removed. To migrate:

1. For each project in your `REGISTRY` KV, add a `corsOrigins` field to the existing JSON value.
2. Remove `CORS_ORIGINS` from your `wrangler.toml` `[vars]` section.

**Before** (env var):
```toml
[vars]
CORS_ORIGINS = "https://app.example.com,https://staging.example.com"
```

**After** (KV):
```json
{
  "signingSecrets": ["your-secret"],
  "corsOrigins": ["https://app.example.com", "https://staging.example.com"]
}
```

To allow all origins (equivalent to the old default of `CORS_ORIGINS = "*"`):
```json
{
  "signingSecrets": ["your-secret"],
  "corsOrigins": ["*"]
}
```

## Behavior Matrix

| Route | KV has `corsOrigins` | CORS headers? |
|-------|---------------------|---------------|
| `/health` | N/A | No |
| `/v1/:project/...` | Yes | Yes (from KV config) |
| `/v1/:project/...` | No | No |
| `OPTIONS /v1/:project/...` | Yes | Yes (204 preflight with CORS) |
| `OPTIONS /v1/:project/...` | No | 204 with no CORS headers |
| `OPTIONS /health` | N/A | 204 with no CORS headers |
| Unknown path | N/A | No |

## CORS Headers Emitted

Both workers emit the same set of CORS headers when `corsOrigins` is configured:

- `Access-Control-Allow-Origin` — the resolved origin
- `Access-Control-Allow-Methods` — `GET, POST, PUT, DELETE, OPTIONS` (subscription), `GET, POST, PUT, DELETE, HEAD, OPTIONS` (core)
- `Access-Control-Allow-Headers` — includes `Authorization`, `Content-Type`, and stream-specific headers
- `Access-Control-Expose-Headers` — includes stream protocol headers (`Stream-Next-Offset`, `Stream-Cursor`, etc.)
