# Admin Dashboard

Unified admin dashboard combining stream management (from admin-core) and session management (from admin-subscription).

## Configuration

Set these environment variables in `wrangler.toml`:

```toml
[vars]
SERVER_URL = "https://durable-streams.your-subdomain.workers.dev"
ADMIN_SECRET = "your-admin-signing-secret"

# Optional: Cloudflare Access JWT verification
CF_ACCESS_TEAM_DOMAIN = "your-team-name"

# Optional: Analytics Engine for dashboard stats
CF_ACCOUNT_ID = "your-account-id"
CF_API_TOKEN = "your-api-token"
```

## Development

```bash
pnpm dev     # Start dev server on port 8788
pnpm build   # Build for production
pnpm test    # Run tests
```

## Missing API Endpoints in estuary-client

The following features are NOT currently available via the HTTP API and therefore cannot work in this simplified admin package without server-side changes:

### Project/Registry Management
- **List projects**: No `GET /v1/projects` endpoint
- **List project streams**: No `GET /v1/projects/:projectId/streams` endpoint
- **Inspect stream metadata**: No `GET /v1/streams/:streamId/inspect` endpoint

### Session Management (Subscription-specific)
- **List sessions**: No `GET /v1/sessions` endpoint
- **Inspect session**: No `GET /v1/sessions/:sessionId` endpoint
- **List stream subscribers**: No `GET /v1/streams/:streamId/subscribers` endpoint
- **List project sessions**: No `GET /v1/projects/:projectId/sessions` endpoint
- **Get stream metadata**: No `GET /v1/streams/:streamId/meta` endpoint

### Analytics
All analytics queries work via Cloudflare Analytics Engine API (when CF_ACCOUNT_ID and CF_API_TOKEN are set).

## What Works

- **Project configuration**: Get/update project config (signing secrets, CORS origins, privacy)
- **Stream operations**: Create, append, read, delete streams
- **Analytics**: System stats, stream stats, hot streams, timeseries (via Analytics Engine)
- **JWT minting**: Generate tokens for authenticated requests

## Architecture

This package uses:
- `@durable-streams-cloudflare/estuary-client` for HTTP API calls
- Environment variables (`SERVER_URL`, `ADMIN_SECRET`) instead of Durable Object service bindings
- No KV namespace or other Cloudflare bindings

## Recommendations for Server

To make this admin package fully functional, the server should expose these HTTP endpoints:

1. `GET /v1/projects` - List all projects
2. `GET /v1/projects/:projectId/streams` - List streams in a project
3. `GET /v1/streams/:streamId/inspect` - Get stream metadata (offsets, etc.)
4. `GET /v1/sessions` - List active sessions
5. `GET /v1/sessions/:sessionId` - Get session details
6. `GET /v1/streams/:streamId/subscribers` - List subscribers for a stream
7. `GET /v1/projects/:projectId/sessions` - List sessions for a project

These endpoints would need to:
- Require admin authentication (via `ADMIN_SECRET`)
- Query the appropriate Durable Objects for the information
- Return JSON responses matching the types expected by the admin UI
