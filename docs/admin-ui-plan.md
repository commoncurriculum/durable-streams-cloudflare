# Admin UI Plan (TanStack Start + Test UI Reuse)

---

## Goal
Create a read-only admin interface for the Durable Streams system that shows:
- System health
- Counts of streams and sessions
- Stream/session detail views with logs and stats

The admin UI should reuse proven UI pieces from the existing test UI, but run as a TanStack Start app with server-side data access.

## Current Assets To Reuse
From `upstream-server/examples/test-ui/src/`:

**Logic to reuse:**
- `lib/stream-store.ts` - singleton subscription manager for message caching
- `lib/stream-db-context.tsx` - `@tanstack/react-db` + `@durable-streams/state` pattern for registry
- `lib/schemas.ts` - state schemas using `@durable-streams/state` createStateSchema

**UI patterns to adapt (custom CSS, not copy-paste):**
- Stream list card layout (registry-driven)
- Log viewer with virtualization (`@tanstack/react-virtual`)
- JSON rendering (`react-json-view` with custom theme)

**Dependencies to add to admin-ui:**
```json
{
  "@durable-streams/client": "workspace:^",
  "@durable-streams/state": "workspace:^",
  "@tanstack/react-db": "latest",
  "@tanstack/react-virtual": "^3.13.13",
  "react-json-view": "^1.21.3"
}
```

## Target Structure
- `packages/admin-ui` (TanStack Start)
- `packages/durable-stream-server` (Cloudflare worker + DO)

## Architecture Overview
- Admin UI deployed to **Cloudflare Pages**, protected by **Cloudflare Access**.
- No custom auth needed - if you can access the Pages app, you have admin access.
- Admin UI routes load data via TanStack Start server functions.
- Server functions call Worker via **Cloudflare Service Binding** (internal, not public HTTP).
- Registry stream (`__registry__`) is the source of truth for stream/session listing.
- `segments_admin` D1 table is used for per-stream segment details (fallback: query DO directly).

### Service Binding Setup
Pages functions access the Worker via service binding, not public HTTP:
```toml
# wrangler.toml (Pages)
[[services]]
binding = "STREAM_WORKER"
service = "durable-stream-server"
```
Server functions call: `env.STREAM_WORKER.fetch(request)`

### Deployment
- **Build**: `pnpm build` in `packages/admin-ui`
- **Deploy**: `wrangler pages deploy` or CI via GitHub Actions
- **Environment**: No secrets needed (service binding handles Worker access)
- **Cloudflare Access**: Configure Access policy for the Pages domain

## Required Server Changes (durable-stream-server)
### 1) Admin auth
- **No custom auth required.** Cloudflare Access protects the Pages app.
- Admin endpoints (`/admin/*`) are called via service binding (not exposed to public internet).
- Worker should verify requests come from service binding (check for `CF-Worker` header or similar).

### 2) New admin endpoints

#### `GET /admin/health`
Checks registry availability, D1 availability (if bound), and R2 availability (if bound).
```json
{
  "status": "healthy" | "degraded" | "unhealthy",
  "services": {
    "registry": { "available": true, "latencyMs": 12 },
    "r2": { "available": true },
    "d1": { "available": true, "latencyMs": 5 }
  }
}
```

#### `GET /admin/streams?limit&after&prefix`
Returns paginated stream list from registry (excludes `subscriptions/*`).
```json
{
  "streams": [
    { "streamId": "chat/room1", "contentType": "application/json", "createdAt": "2024-01-15T10:30:00Z", "closed": false }
  ],
  "nextCursor": "abc123"
}
```

**Implementation note:** Registry is a stream, not a DB. Options:
1. Read entire registry on first call, cache in memory, paginate from cache
2. Stream registry and stop after `limit` items (no `total`, cursor = last offset)
3. Future: index streams in D1 for proper pagination

Recommended: Option 2 (stream with offset cursor) for simplicity.

#### `GET /admin/streams/:streamId`
Returns stream meta + aggregated stats (segments, bytes, messages, subscriber count).
```json
{
  "streamId": "chat/room1",
  "contentType": "application/json",
  "createdAt": "2024-01-15T10:30:00Z",
  "closed": false,
  "tailOffset": "3_1024",
  "stats": {
    "segmentCount": 3,
    "totalBytes": 102400,
    "messageCount": 1500,
    "subscriberCount": 5
  }
}
```

**Stats source:**
- `segmentCount`: COUNT from DO `segments` table
- `totalBytes`: SUM of segments `size_bytes` + `stream_meta.segment_bytes` (hot log)
- `messageCount`: SUM of segments `message_count` + `stream_meta.segment_messages` (hot log)
- `subscriberCount`: `stream_meta.subscriber_count`

#### `GET /admin/streams/:streamId/segments?limit&after`
Returns paginated segment list for a stream.
```json
{
  "segments": [
    { "readSeq": 2, "startOffset": "2_0", "endOffset": "2_512", "r2Key": "...", "sizeBytes": 51200, "messageCount": 500, "createdAt": "2024-01-15T10:30:00Z" }
  ],
  "nextCursor": "3"
}
```

**Data source:**
- If D1 bound: query `segments_admin` table (fast, global index)
- If D1 not bound: call DO `/internal/admin/segments` (queries DO SQLite `segments` table)

#### `GET /admin/streams/:streamId/logs?offset&limit`
Returns tail/log view in structured JSON (handles text/json/binary).
```json
{
  "messages": [
    { "offset": "0_0", "data": "...", "encoding": "utf8" | "base64" }
  ],
  "nextOffset": "0_100",
  "hasMore": true
}
```

#### `GET /admin/sessions?limit&after`
Returns paginated session list (filtered from registry `subscriptions/*` entries).
```json
{
  "sessions": [
    { "sessionId": "sess_abc", "createdAt": "2024-01-15T10:30:00Z" }
  ],
  "nextCursor": "sess_def"
}
```

**Note:** `subscribedStreams` deferred to detail view to avoid N+1 DO calls in list.

#### `GET /admin/sessions/:sessionId`
Returns session detail with subscribed streams and log tail.

Session subscriptions are stored in the Session DO's `session_subscriptions` table
(see `docs/fan-in-subscriptions.md` for schema details).
```json
{
  "sessionId": "sess_abc",
  "createdAt": "2024-01-15T10:30:00Z",
  "subscribedStreams": ["chat/room1", "chat/room2"],
  "stats": {
    "messageCount": 500,
    "tailOffset": "0_500"
  }
}
```

### 3) Internal DO routes (called by worker)
- `GET /internal/admin/meta` - stream metadata + stats
- `GET /internal/admin/segments` - paginated segment list
- `GET /internal/admin/logs` - structured log tail
- `GET /internal/admin/subscriptions` - session's subscribed streams (from `session_subscriptions` table)

### 4) Error response format
All admin endpoints return consistent error responses:
```json
{
  "error": {
    "code": "NOT_FOUND" | "INTERNAL_ERROR" | "INVALID_REQUEST" | "SERVICE_UNAVAILABLE",
    "message": "Stream not found: chat/room1"
  }
}
```
HTTP status codes: 400 (invalid request), 404 (not found), 500 (internal), 503 (DO unavailable).

### 5) Session registry
- Ensure session streams (`subscriptions/<sessionId>`) emit registry events on first creation.
- Admin UI treats `subscriptions/*` entries as sessions.

### 6) System stream filtering
System streams are hidden from stream list but accessible via direct URL:
- `__registry__` - internal registry
- `__presence__` - presence tracking
Filter: exclude streams starting with `__` from `/admin/streams` list.

## Admin UI Plan (TanStack Start)
### Routes
TanStack Start uses `$param` syntax for dynamic segments.

- `/` Overview (`src/routes/index.tsx`)
  - Health status
  - Total streams count (from registry)
  - Total sessions count (from registry)
  - Recent streams/sessions

- `/streams` Stream list (`src/routes/streams/index.tsx`)
  - Registry-driven list
  - Excludes `subscriptions/*` and `__*` system streams

- `/streams/$streamId` Stream detail (`src/routes/streams/$streamId.tsx`)
  - Stream metadata + stats
  - Segment list (collapsible)
  - Log tail viewer

- `/sessions` Session list (`src/routes/sessions/index.tsx`)
  - Registry-driven list (filter `subscriptions/*` prefix)
  - Shows session ID, created time

- `/sessions/$sessionId` Session detail (`src/routes/sessions/$sessionId.tsx`)
  - Session metadata
  - List of subscribed streams
  - Log tail viewer

### Components to reuse/adapt
- Stream list UI and styling from test UI (strip create/delete actions).
- Stream viewer (log tail) with JSON rendering and virtualization.
- Registry store logic for stream discovery.

### Data access
- Start server functions call admin endpoints (no auth token needed, same Cloudflare project).
- Use `@durable-streams/client` for streaming data (registry, logs) - handles long-poll/reconnection automatically.
- Admin endpoints return structured JSON; client library handles the streaming protocol.

### UX considerations
- **Loading states**: Skeleton loaders for lists, spinners for detail fetches
- **Error states**: Clear error messages with retry buttons when API fails
- **Empty states**: Friendly messages ("No streams found", "No sessions active")
- **Refresh**: Manual refresh button on each page; auto-refresh toggle for log tail
- **Pagination**: Cursor-based with "Load more" pattern (not page numbers)
- **Closed streams**: Visual indicator (badge or icon) for streams that are closed

## Migration Steps
1. Move `examples/test-ui` UI elements into `packages/admin-ui`.
2. Remove create/delete/write actions (read-only requirement).
3. Build admin routes + server loaders.
4. Implement admin endpoints in `durable-stream-server`.
5. Wire health and counts to UI.

## Acceptance Criteria
- Admin UI loads behind Cloudflare Access and shows health, counts, and details.
- Stream list is registry-based and stable across reloads.
- Stream/session detail pages show logs and stats.
- Admin API types are shared between server and UI (no type drift).
- Uses `@durable-streams/client` for streaming data.

## Notes
- This plan assumes the server changes live in `packages/durable-stream-server`.
- The existing test UI is a good base for the stream list and log viewer, but it lacks global health/session/admin stats and must be adapted.
- Test UI location: `upstream-server/examples/test-ui/src/`
- D1 is optional; if not bound, stats come from DO SQLite (works but slower for aggregates).
- **UI approach**: Custom CSS (no Tailwind/shadcn), reuse *logic* from test-ui (stream-store, react-db patterns), build our own components.
- Session subscriptions come from `session_subscriptions` table in Session DO (see `docs/fan-in-subscriptions.md`).
- **Stream ID encoding**: Worker already handles `decodeURIComponent` (see `src/worker.ts:305`). UI must `encodeURIComponent` stream IDs in URLs.
- **Timestamps**: All API responses use ISO-8601 format (e.g., `"2024-01-15T10:30:00Z"`).

## Type Safety

**Problem:** Admin API response types need to be shared between server and UI to prevent drift.

**Types from `@durable-streams/client`** (already available):
- `Offset` - offset strings
- `JsonBatch`, `ByteChunk`, `TextChunk` - streaming chunk types
- `StreamResponse` - full streaming response
- `HeadResult` - stream metadata (contentType, offset, streamClosed, etc.)
- Error types, options, etc.

**Admin-specific types** (need to define):
- `AdminHealthResponse` - health check result
- `AdminStreamListResponse` - paginated stream list
- `AdminStreamDetailResponse` - stream metadata + stats
- `AdminSegmentListResponse` - paginated segment list
- `AdminSessionListResponse` - paginated session list
- `AdminSessionDetailResponse` - session detail
- `AdminErrorResponse` - error response format
- `AdminLogMessage` - individual log message with encoding

**Recommendation:** Create a shared types package:
```
packages/
  admin-types/           # NEW: admin-specific types only
    src/
      api.ts             # Admin API response types
      index.ts           # re-exports + re-exports relevant types from @durable-streams/client
    package.json
  admin-ui/
    package.json         # depends on @durable-streams/admin-types
  durable-stream-server/
    package.json         # depends on @durable-streams/admin-types
```

The server imports types when building responses; the UI imports types for type-safe fetch wrappers.

**Alternative:** If shared package feels heavy, define types in server's `src/admin/types.ts` and import directly in UI (works since both are in same monorepo).

---

## Task Breakdown

### Server Tasks (packages/durable-stream-server)

| # | Task | Files |
|---|------|-------|
| S1 | Create shared admin types package | `packages/admin-types/` |
| S2 | Create admin router | `src/http/admin_router.ts` |
| S3 | Implement `GET /admin/health` | `src/http/handlers/admin.ts` |
| S4 | Implement `GET /admin/streams` (list via registry) | `src/http/handlers/admin.ts` |
| S5 | Add internal DO admin routes (meta, segments, logs, subscriptions) | `src/http/router.ts`, `src/http/handlers/admin_internal.ts` |
| S6 | Implement `GET /admin/streams/:id` | `src/http/handlers/admin.ts` |
| S7 | Implement `GET /admin/streams/:id/segments` (via D1 `segments_admin`) | `src/http/handlers/admin.ts` |
| S8 | Implement `GET /admin/streams/:id/logs` | `src/http/handlers/admin.ts` |
| S9 | Implement `GET /admin/sessions` + `/:id` | `src/http/handlers/admin.ts` |
| S10 | Wire admin routes into worker | `src/worker.ts` |
| S11 | Write admin endpoint tests | `test/implementation/admin_endpoints.test.ts` |

### UI Tasks (packages/admin-ui)

| # | Task | Files |
|---|------|-------|
| U0 | Add dependencies (react-json-view, react-virtual, react-db, durable-streams pkgs, admin-types) | `package.json` |
| U1 | Configure service binding in wrangler.toml | `wrangler.toml` |
| U2 | Create server functions (call admin API with shared types) | `src/server/admin-api.ts` |
| U3 | Create custom styles (inspired by test-ui, not copied) | `src/styles.css` |
| U4 | Create `HealthStatus` component | `src/components/HealthStatus.tsx` |
| U5 | Create `StreamList` component (adapt from test-ui) | `src/components/StreamList.tsx` |
| U6 | Create `LogViewer` component (adapt from test-ui) | `src/components/LogViewer.tsx` |
| U7 | Create `SegmentTable` component | `src/components/SegmentTable.tsx` |
| U8 | Create `StatsCards` component | `src/components/StatsCards.tsx` |
| U9 | Implement `/` overview route | `src/routes/index.tsx` |
| U10 | Implement `/streams` route | `src/routes/streams/index.tsx` |
| U11 | Implement `/streams/$streamId` route | `src/routes/streams/$streamId.tsx` |
| U12 | Implement `/sessions` + `/$sessionId` routes | `src/routes/sessions/` |
| U13 | Add nav layout | `src/routes/__root.tsx` |
| U14 | Write component tests | `src/components/__tests__/` |

---

## Execution Order

**Phase 1: Types + Server foundation**
1. S1 (shared types package)
2. S2-S3 (admin router + health endpoint)

**Phase 2: Server endpoints**
3. S5 (internal DO routes - needed by detail endpoints)
4. S4, S6-S8 (streams endpoints)
5. S9 (sessions endpoints)
6. S10-S11 (integration + tests)

**Phase 3: UI**
7. U0-U3 (dependencies + foundation)
8. U4-U8 (components)
9. U9-U13 (routes + layout)
10. U14 (component tests)
