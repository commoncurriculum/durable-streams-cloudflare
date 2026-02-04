# Admin UI Plan (TanStack Start + Test UI Reuse)

## Goal
Create a read-only admin interface for the Durable Streams system that shows:
- System health
- Counts of streams and sessions
- Stream/session detail views with logs and stats

The admin UI should reuse proven UI pieces from the existing test UI, but run as a TanStack Start app with server-side data access and secure admin token handling.

## Current Assets To Reuse
From `examples/test-ui` in the upstream repo:
- Stream list UI (registry-driven)
- Stream viewer (log tail + JSON rendering + virtualization)
- Registry stream wiring
- JSON message rendering (ReactJson)

## Target Structure
- `packages/admin-ui` (TanStack Start)
- `packages/durable-stream-server` (Cloudflare worker + DO)

## Architecture Overview
- Admin UI routes load data via Start server functions.
- Server functions proxy requests to new admin endpoints on the worker.
- Worker admin endpoints are protected with `ADMIN_TOKEN` (no token in browser).
- Registry stream is used as the source of truth for global stream/session listing.

## Required Server Changes (durable-stream-server)
### 1) Admin auth
- Add `ADMIN_TOKEN` env var.
- `/admin/*` endpoints must require `Authorization: Bearer <ADMIN_TOKEN>`.

### 2) New admin endpoints
- `GET /admin/health`
  - Checks registry availability, D1 availability (if bound), and R2 availability (if bound).
- `GET /admin/streams/:streamId`
  - Returns stream meta + aggregated stats (segments, bytes, messages, subscriber count).
- `GET /admin/streams/:streamId/segments?limit&after`
  - Returns paginated segment list for a stream.
- `GET /admin/streams/:streamId/logs?tail&offset`
  - Returns tail/log view in a structured JSON payload (text/json/binary).

### 3) Internal DO routes (called by worker)
- `GET /internal/admin/meta`
- `GET /internal/admin/segments`
- `GET /internal/admin/logs`

### 4) Session registry
- Ensure session streams (`subscriptions/<sessionId>`) emit registry events on first creation.
- Admin UI treats `subscriptions/*` entries as sessions.

## Admin UI Plan (TanStack Start)
### Routes
- `/` Overview
  - Health status
  - Total streams count
  - Total sessions count
  - Recent streams/sessions (from registry)

- `/streams` Stream list
  - Registry-driven list with search/filter
  - Distinguish streams vs sessions by prefix

- `/streams/:streamId`
  - Stream metadata + stats
  - Segment list
  - Log tail (polling)

- `/sessions/:sessionId`
  - Session metadata
  - List of subscribed streams
  - Log tail

### Components to reuse/adapt
- Stream list UI and styling from test UI (strip create/delete actions).
- Stream viewer (log tail) with JSON rendering and virtualization.
- Registry store logic for stream discovery.

### Data access
- Start server functions proxy all admin requests and attach `ADMIN_TOKEN`.
- Registry updates pulled periodically (poll or long-poll via server).
- Log tailing via polling with `nextOffset` cursor.

## Migration Steps
1. Move `examples/test-ui` UI elements into `packages/admin-ui`.
2. Remove create/delete/write actions (read-only requirement).
3. Build admin routes + server loaders.
4. Implement admin endpoints in `durable-stream-server`.
5. Wire health and counts to UI.

## Acceptance Criteria
- Admin UI loads behind Access and shows health, counts, and details.
- Stream list is registry-based and stable across reloads.
- Stream/session detail pages show logs and stats.
- Admin endpoints require `ADMIN_TOKEN` and never expose it to the browser.

## Notes
- This plan assumes the server changes live in `packages/durable-stream-server`.
- The existing test UI is a good base for the stream list and log viewer, but it lacks global health/session/admin stats and must be adapted.
