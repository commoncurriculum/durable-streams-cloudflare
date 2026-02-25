# Admin Package - Implementation Notes

## What Was Done

1. **Created unified admin package** combining admin-core and admin-subscription
2. **Simplified architecture**:
   - No Durable Object service bindings
   - No KV namespace
   - Only two environment variables: `SERVER_URL` and `ADMIN_SECRET`
   - Uses native `fetch` API instead of service bindings

3. **Copied and adapted**:
   - All UI components from both packages
   - All routes (streams management + session management)
   - Utilities (formatters, JWT minting, queries)
   - Basic test setup

4. **Fixed compatibility issues**:
   - Replaced estuary-client axios calls with native fetch (Workers doesn't support Node.js http/https modules)
   - All API calls now use native fetch for Workers compatibility

## What Works

- ✅ Build succeeds (both client and server)
- ✅ Unit tests pass (16/16 tests)
- ✅ TypeScript compiles without errors
- ✅ Project configuration management (via HTTP API)
- ✅ Analytics queries (via Cloudflare Analytics Engine API)
- ✅ Basic stream operations (create, append)

## What Doesn't Work (Missing HTTP Endpoints)

These features require new HTTP endpoints on the server:

### Project/Registry Management
- `GET /v1/projects` - List all projects
- `GET /v1/projects/:projectId/streams` - List streams in a project

### Stream Inspection
- `GET /v1/streams/:streamId/inspect` - Get stream metadata (offsets, producers, etc.)

### Session Management (Subscription-specific)
- `POST /v1/sessions` - Create/touch a session
- `GET /v1/sessions` - List all active sessions
- `GET /v1/sessions/:sessionId` - Get session details
- `GET /v1/streams/:streamId/subscribers` - List subscribers for a stream
- `GET /v1/projects/:projectId/sessions` - List sessions for a project
- `POST /v1/sessions/:sessionId/subscribe` - Subscribe session to stream
- `POST /v1/sessions/:sessionId/unsubscribe` - Unsubscribe session from stream
- `POST /v1/sessions/:sessionId/publish` - Publish to session
- `DELETE /v1/sessions/:sessionId` - Delete session

Currently these operations throw errors with messages explaining they're not available via HTTP API.

## Testing

- **Unit tests**: Pass (formatters, router validation)
- **Browser tests**: Setup created but not fully tested due to missing server endpoints

To run tests:
```bash
pnpm test        # Runs vitest + playwright
pnpm test:browser # Just playwright tests
```

## Deployment

1. Build the package: `pnpm build`
2. Configure `wrangler.toml` with your `SERVER_URL` and `ADMIN_SECRET`
3. Deploy: `pnpm deploy`

## Next Steps

To make this admin package fully functional, the server package needs to expose the missing HTTP endpoints listed above. These endpoints should:

1. Require admin authentication (validate JWT signed with `ADMIN_SECRET`)
2. Query the appropriate Durable Objects for the information
3. Return JSON responses matching the types expected by the admin UI

## Notes for Server Implementation

When adding these endpoints:

1. **Authentication**: Use the same JWT validation as existing endpoints, but check for admin privileges
2. **DO Communication**: Endpoints will need to call DO methods like:
   - `StreamDO.listStreams(projectId)`
   - `StreamDO.inspect(streamId)`
   - `SubscriptionDO.listSessions(projectId)`
   - `SubscriptionDO.inspectSession(sessionId)`
   
3. **Response Format**: Match the types already defined in `packages/admin/src/lib/analytics.ts`

## Estuary Client Note

The `@durable-streams-cloudflare/estuary-client` package exists and was considered, but is NOT used in the server-side code because:

1. It depends on axios, which requires Node.js modules (`http`, `https`) not available in Cloudflare Workers
2. Native `fetch` is the standard in Workers and doesn't require external dependencies
3. The generated client could still be useful for React Query hooks on the client-side if needed

The client is kept as a dependency for potential future use, but all server-side code uses native fetch.
