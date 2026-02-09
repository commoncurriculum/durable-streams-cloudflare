# Chapter 9: Subscription Architecture

The subscription layer is a separate Cloudflare Worker that provides pub/sub fan-out on top of the core streaming infrastructure. Publishers write once to a source stream; the subscription worker fans the message out to every subscriber's individual session stream. Clients read their session stream directly from the core worker (through CDN).

## Overview

```
Publisher ── POST /v1/:project/publish/:streamId ──> Subscription Worker
                                                  │
                                                  ├─> Core: write to source stream
                                                  ├─> SubscriptionDO: get subscribers
                                                  └─> Fan-out: write to each session stream
                                                       (session:alice, session:bob, ...)

Client ── GET /v1/:project/stream/session:alice?live=sse ──> Core Worker (via CDN)
```

The subscription worker communicates with core via a **Cloudflare service binding** (`CORE`). This is a direct in-process RPC call, not an HTTP request -- zero network hop, zero auth overhead. The `CoreService` interface exposes `headStream`, `putStream`, `postStream`, and `deleteStream` methods.

## Durable Object Architecture

Two Durable Object classes, each with its own SQLite database:

| DO Class | Key pattern | Role |
|----------|------------|------|
| `SubscriptionDO` | `{projectId}/{streamId}` | Per-stream subscriber registry. Stores which sessions subscribe to this stream. Handles publish + fan-out. |
| `SessionDO` | `{projectId}/{sessionId}` | Per-session subscription tracker. Stores which streams this session subscribes to. Used by cleanup and `GET /session/:sessionId`. |

### SubscriptionDO Schema

```sql
CREATE TABLE subscribers (
  session_id TEXT PRIMARY KEY,
  subscribed_at INTEGER NOT NULL
);

CREATE TABLE fanout_state (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
```

The `fanout_state` table stores a single row (`key = 'next_seq'`) tracking the monotonic fanout sequence number used for producer-based deduplication.

### SessionDO Schema

```sql
CREATE TABLE subscriptions (
  stream_id TEXT PRIMARY KEY,
  subscribed_at INTEGER NOT NULL
);
```

Both DOs use `blockConcurrencyWhile` in the constructor for schema initialization.

## Publish and Fan-Out Flow

When a message is published to a stream:

1. **Write to source stream**: The SubscriptionDO calls `CORE.postStream(projectId/streamId, payload, contentType)` to durably append to the source stream.
2. **Clone payload**: ArrayBuffers are transferred across RPC boundaries, so the payload is cloned before the source write so fan-out can reuse it.
3. **Assign fanout sequence**: A monotonic `fanoutSeq` is incremented and persisted. Each fan-out write uses producer headers `{ producerId: "fanout:<streamId>", producerEpoch: "1", producerSeq: N }` for deduplication at the session stream level.
4. **Get subscribers**: Local SQLite query on the SubscriptionDO.
5. **Fan out**: Write a copy of the payload to each subscriber's session stream via `CORE.postStream(projectId/sessionId, payload, contentType, producerHeaders)`.

### Inline vs Queued Fan-Out

The fan-out path is chosen based on subscriber count and configuration:

| Condition | Fan-out mode | Behavior |
|-----------|-------------|----------|
| `count <= FANOUT_QUEUE_THRESHOLD` (default 200) | Inline | Fan-out happens synchronously within the publish request |
| `count > threshold` and `FANOUT_QUEUE` bound | Queued | Session IDs are batched and enqueued; a queue consumer handles delivery |
| `count > MAX_INLINE_FANOUT` (default 1000) and no queue | Skipped | Fan-out is skipped to protect the publish path; source write still succeeds |
| Circuit breaker open | Circuit-open | Inline fan-out is skipped; source write still succeeds |

The source stream write always succeeds regardless of fan-out outcome. Fan-out failures never cause a publish to fail.

### Fan-Out Batching

Inline fan-out processes subscribers in batches of `FANOUT_BATCH_SIZE` (50) using `Promise.allSettled`. Each RPC call has a timeout of `FANOUT_RPC_TIMEOUT_MS` (10s) enforced via `Promise.race` with `setTimeout`.

For queued fan-out, session IDs are split into groups of `FANOUT_QUEUE_BATCH_SIZE` (50) per queue message. Queue messages are sent via `Queue.sendBatch()` with a 100-message limit per batch call. The payload is base64-encoded in the queue message.

## Circuit Breaker

The SubscriptionDO implements a circuit breaker for inline fan-out to protect the publish path when downstream session streams are failing.

| State | Behavior |
|-------|----------|
| **Closed** (default) | Inline fan-out proceeds normally |
| **Open** | Inline fan-out is skipped entirely; source write still succeeds |
| **Half-open** | One fan-out attempt is allowed to test recovery |

State transitions:

- **Closed -> Open**: After `CIRCUIT_BREAKER_FAILURE_THRESHOLD` (5) consecutive fan-out batches with failures.
- **Open -> Half-open**: After `CIRCUIT_BREAKER_RECOVERY_MS` (60s) since the last failure.
- **Half-open -> Closed**: If the test fan-out has any successes.
- **Half-open -> Open**: If the test fan-out has only failures.
- **Any -> Closed**: If a fan-out batch completes with zero failures.

The circuit breaker state is in-memory (not persisted). A DO restart resets to closed.

## Producer Deduplication in Fan-Out

Each SubscriptionDO maintains a monotonically increasing `fanoutSeq` counter persisted in the `fanout_state` table. When fanning out, each write to a session stream includes producer headers:

```
Producer-Id: fanout:<streamId>
Producer-Epoch: 1
Producer-Seq: <fanoutSeq>
```

Core's producer fencing rejects duplicate writes (same producer + epoch + seq) with an idempotent 204. This means retried fan-out (e.g., from the queue consumer) is safe -- duplicates are silently absorbed.

## Stale Subscriber Auto-Cleanup

During fan-out, if `CORE.postStream` returns a 404 for a session stream (the session was deleted or expired), that session ID is collected into a `staleSessionIds` list. After the fan-out batch completes, stale subscribers are removed from the SubscriptionDO's `subscribers` table in a single SQL `DELETE ... WHERE session_id IN (...)`.

The queue consumer also performs stale cleanup by calling `stub.removeSubscribers(staleSessionIds)` on the SubscriptionDO via RPC.

## Queue Consumer

The queue consumer (`fanout-consumer.ts`) processes batched fan-out messages. Each message contains:

```ts
interface FanoutQueueMessage {
  projectId: string;
  streamId: string;
  sessionIds: string[];        // Batch of subscriber session IDs
  payload: string;             // Base64-encoded payload
  contentType: string;
  producerHeaders?: { producerId: string; producerEpoch: string; producerSeq: string };
}
```

For each message, the consumer:
1. Decodes the base64 payload back to `ArrayBuffer`.
2. Calls the shared `fanoutToSubscribers()` function (same as inline fan-out).
3. Removes stale subscribers (404s) from the SubscriptionDO via RPC.
4. **Ack** if all writes succeeded or returned 404 (stale).
5. **Retry** if any writes had server errors (5xx / network failures).

## Subscribe Flow

1. **Look up source stream content type**: `CORE.headStream(projectId/streamId)`. Fails if the source stream does not exist.
2. **Create or touch session stream**: `CORE.putStream(projectId/sessionId, { expiresAt, contentType })`. The content type must match the source stream. If the session stream already exists (409), verify content type compatibility.
3. **Add subscriber to SubscriptionDO**: `stub.addSubscriber(sessionId)` via RPC to the stream-keyed DO.
4. **Track subscription on SessionDO**: `sessionStub.addSubscription(streamId)` via RPC to the session-keyed DO.
5. **Record metrics**: Subscribe event and (if new session) session create event.

If step 3 fails and the session was just created in step 2, the session stream is rolled back (deleted from core).

**Response**:
```json
{
  "sessionId": "user-alice",
  "streamId": "chat-room-1",
  "sessionStreamPath": "/v1/myapp/stream/user-alice",
  "expiresAt": 1707500000000,
  "isNewSession": true
}
```

## Unsubscribe Flow

1. **Remove subscriber from SubscriptionDO**: `stub.removeSubscriber(sessionId)`.
2. **Remove subscription from SessionDO**: `sessionStub.removeSubscription(streamId)`.
3. **Record metrics**.

## Session Lifecycle

Sessions have a configurable TTL (`SESSION_TTL_SECONDS`, default 1800 = 30 minutes). The session stream in core is created with an `expiresAt` timestamp.

| Operation | Route | Effect |
|-----------|-------|--------|
| Get session | `GET /v1/:project/session/:sessionId` | Returns session info + list of active subscriptions (from SessionDO) |
| Touch session | `POST /v1/:project/session/:sessionId/touch` | Resets the session stream's `expiresAt` in core |
| Delete session | `DELETE /v1/:project/session/:sessionId` | Deletes the session stream from core |

## HTTP API

All routes are under `/v1/:project/`. The project ID is validated against `^[a-zA-Z0-9_-]+$`. Session IDs must be UUIDs. Stream IDs allow alphanumeric, hyphens, underscores, colons, and periods.

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/v1/:project/subscribe` | `{ sessionId, streamId }` | Subscribe a session to a stream |
| `DELETE` | `/v1/:project/unsubscribe` | `{ sessionId, streamId }` | Unsubscribe a session from a stream |
| `POST` | `/v1/:project/publish/:streamId` | Raw payload (any content type) | Write to source stream + fan out to subscribers |
| `GET` | `/v1/:project/session/:sessionId` | -- | Get session info and subscriptions |
| `POST` | `/v1/:project/session/:sessionId/touch` | -- | Extend session TTL |
| `DELETE` | `/v1/:project/session/:sessionId` | -- | Delete session and its stream |
| `GET` | `/health` | -- | Health check (bypasses auth) |

**Publish response headers** include fan-out status:
- `Stream-Fanout-Count`: Total subscriber count
- `Stream-Fanout-Successes`: Successful fan-out writes
- `Stream-Fanout-Failures`: Failed fan-out writes
- `Stream-Fanout-Mode`: `inline`, `queued`, `circuit-open`, or `skipped`

Reading the session stream is done directly via the **core worker**: `GET /v1/:project/stream/session:<sessionId>`.

## Authentication

See Chapter 2a (Authentication) for the full auth model. The subscription worker uses the same per-project JWT system as core, with action-based scope mapping:

| Action | Required scope |
|--------|---------------|
| `publish` | `write` |
| `unsubscribe`, `deleteSession` | `write` |
| `subscribe`, `getSession`, `touchSession` | `read` or `write` |

Auth is configured via `createSubscriptionWorker({ authorize: projectJwtAuth() })`. Custom auth callbacks receive a `SubscriptionRoute` discriminated union with the parsed action, project, and IDs.

## Analytics Engine Metrics

Every significant event writes a data point to Analytics Engine (`METRICS` binding). The metrics schema uses:
- `blobs[0-3]`: streamId, sessionId, eventType, errorType
- `doubles[0-3]`: count, latencyMs, and event-specific values
- `indexes[0]`: event category for querying

| Category | Event Types |
|----------|-------------|
| `fanout` | `fanout`, `fanout_queued` |
| `subscription` | `subscribe`, `unsubscribe` |
| `session` | `session_create`, `session_touch`, `session_delete`, `session_expire` |
| `cleanup` | `cleanup_batch` |
| `publish` | `publish` |
| `publish_error` | `publish_error` |
| `http` | Per-request (endpoint, method, status, latency) |

## Scheduled Cleanup (Cron)

A cron trigger runs every 5 minutes (`*/5 * * * *`). The `cleanupExpiredSessions` function:

1. **Query Analytics Engine** for expired sessions: finds sessions where `(now - lastActivity) > ttlSeconds * 1000` using `session_create` and `session_touch` events.
2. **For each expired session** (batched in groups of 10):
   a. Get the session's subscriptions from the **SessionDO** (source of truth).
   b. Remove the session from each **SubscriptionDO** via `stub.removeSubscriber()` (batched in groups of 20 with `Promise.allSettled`).
   c. Delete the session stream from core via `CORE.deleteStream()`.
3. **Record cleanup metrics**: expired count, streams deleted, subscriptions removed/failed, latency.

Cleanup requires `ACCOUNT_ID` and `API_TOKEN` environment variables for Analytics Engine SQL queries. Without these, cleanup is silently skipped.

## Wrangler Bindings

```toml
[durable_objects]
bindings = [
  { name = "SUBSCRIPTION_DO", class_name = "SubscriptionDO" },
  { name = "SESSION_DO", class_name = "SessionDO" },
]

[[services]]
binding = "CORE"
service = "durable-streams"

[[analytics_engine_datasets]]
binding = "METRICS"

[[kv_namespaces]]
binding = "REGISTRY"

[[queues.producers]]
binding = "FANOUT_QUEUE"
queue = "subscription-fanout"

[triggers]
crons = ["*/5 * * * *"]
```

## Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEFAULT_SESSION_TTL_SECONDS` | 1800 (30 min) | Default session expiry |
| `FANOUT_BATCH_SIZE` | 50 | Concurrent writes per fan-out batch |
| `FANOUT_QUEUE_THRESHOLD` | 200 | Subscriber count above which fan-out goes to queue |
| `FANOUT_QUEUE_BATCH_SIZE` | 50 | Session IDs per queue message |
| `MAX_INLINE_FANOUT` | 1000 | Hard cap on inline fan-out without a queue |
| `FANOUT_RPC_TIMEOUT_MS` | 10,000 | Per-RPC timeout for fan-out writes |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | 5 | Consecutive failures before opening circuit |
| `CIRCUIT_BREAKER_RECOVERY_MS` | 60,000 | Time before half-open retry |

## Key Modules

| File | Role |
|------|------|
| `src/http/create_worker.ts` | Worker factory: Hono app, CORS, auth middleware, metrics, route mounting, queue + cron handlers |
| `src/http/worker.ts` | `WorkerEntrypoint` subclass: HTTP entry + admin RPC methods |
| `src/http/auth.ts` | Auth types, route parsing, JWT verification, `projectJwtAuth()` factory |
| `src/http/routes/publish.ts` | `POST /publish/:streamId` route |
| `src/http/routes/subscribe.ts` | `POST /subscribe`, `DELETE /unsubscribe`, `DELETE /session/:sessionId` routes |
| `src/http/routes/session.ts` | `GET /session/:sessionId`, `POST /session/:sessionId/touch` routes |
| `src/subscriptions/do.ts` | `SubscriptionDO` class: subscriber storage, publish, fan-out, circuit breaker |
| `src/subscriptions/fanout.ts` | Shared `fanoutToSubscribers()`: batched RPC writes with timeout, stale detection |
| `src/subscriptions/publish.ts` | Routes publish to the correct SubscriptionDO stub |
| `src/subscriptions/subscribe.ts` | Subscribe flow: create session stream, add to both DOs |
| `src/subscriptions/unsubscribe.ts` | Unsubscribe flow: remove from both DOs |
| `src/session/do.ts` | `SessionDO` class: per-session subscription tracking |
| `src/session/index.ts` | Session operations: get, touch, delete |
| `src/queue/fanout-consumer.ts` | Queue consumer: processes async fan-out messages |
| `src/cleanup/index.ts` | Cron cleanup: query AE for expired sessions, remove subscriptions, delete streams |
| `src/analytics/index.ts` | Analytics Engine SQL query helpers |
| `src/metrics/index.ts` | `Metrics` class: structured data point writes |
| `src/constants.ts` | Thresholds, patterns, validation functions |
| `src/client.ts` | `CoreService` interface (service binding RPC contract) |
| `src/env.ts` | `AppEnv` type (all wrangler bindings) |

## Historical Note

The original design for this layer (preserved in git history) envisioned a different architecture: a "Hub DO" for live SSE/WebSocket push, client-side heartbeat with offset acking, server-side offset tracking tables (`session_offsets`), and a `/v1/heartbeat` endpoint. The implemented system is simpler: no Hub DO, no live push from the subscription worker, no heartbeat, no offset tracking. Instead, each session gets its own Durable Stream in core, and clients read that stream directly. The subscription worker is a stateless fan-out coordinator, not a connection hub.
