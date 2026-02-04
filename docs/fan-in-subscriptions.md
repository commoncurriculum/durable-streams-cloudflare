# Fan-In Subscription Streams (Planned, Session-Centered)

## Overview
Status: **Planned (not implemented)**.

Fan-in streams aggregate updates from many underlying streams into a single
subscription stream per **session**. Clients open one SSE or long-poll
connection to the fan-in stream and receive multiplexed events with the source
stream id and offset.

This is an application-level pattern built on top of Durable Streams. It is not
part of the core protocol and is intended for v2 scale when clients subscribe to
hundreds of feeds.

## Goals
- Reduce client connections by multiplexing many streams into one.
- Preserve resumability via a single fan-in offset cursor.
- Keep authorization and subscription rules centralized.
- Allow horizontal fan-out without blocking stream writers.

## Non-Goals
- Replace or modify the core Durable Streams protocol.
- Guarantee zero duplication across fan-in delivery (clients must be tolerant).
- Provide global discovery of streams.

## Core Concepts
- **Subject**: a session. The session id is the subscription identity.
- **Fan-in stream**: a Durable Stream at `subscriptions/<sessionId>` that carries
  envelope events.
- **Session DO**: the fan-in stream DO for a given session; stores the session's
  subscription list.
- **Stream DO**: the source stream's DO; stores the stream's subscriber list.
- **Envelope events**: JSON messages containing source stream id, source offset,
  event type, and payload.
- **Fan-out writer**: process that appends envelope events into session fan-in
  streams.

## Data Model (Per-DO SQLite)

### Stream DO (per stream)
```sql
CREATE TABLE stream_subscribers (
  session_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
```

Maintain a subscriber count on the stream meta row to avoid counting on every
append:
```sql
ALTER TABLE stream_meta ADD COLUMN subscriber_count INTEGER NOT NULL DEFAULT 0;
```

### Session DO (fan-in stream DO)
```sql
CREATE TABLE session_subscriptions (
  stream_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
```

## HTTP API (Worker)
Planned endpoints (not implemented):

1. `POST /v1/subscriptions`
Request body:
```json
{ "sessionId": "sess-123", "streamId": "doc-abc" }
```
Behavior: authenticate, authorize, route to session DO
`subscriptions/<sessionId>` to subscribe.

2. `DELETE /v1/subscriptions`
Request body:
```json
{ "sessionId": "sess-123", "streamId": "doc-abc" }
```
Behavior: authenticate, authorize, route to session DO
`subscriptions/<sessionId>` to unsubscribe.

3. `GET /v1/subscriptions/{sessionId}`
Returns the list of subscribed `streamId`s from the session DO.

All stream reads/writes still use the core stream endpoint:
`/v1/stream/<stream-id>`.

## Internal DO-to-DO Calls (Subscription Updates)
The session DO updates the stream DO subscriber list via trusted internal calls:
- `POST /internal/subscribers` with body `{ "sessionId": "..." }`
- `DELETE /internal/subscribers` with body `{ "sessionId": "..." }`

These are internal-only routes (not public).

## Subscribe / Unsubscribe Flow
### Subscribe
1. Session DO verifies auth/session ownership and stream ACL.
2. Session DO calls stream DO to add `sessionId` to `stream_subscribers`.
3. On success, session DO inserts `streamId` into `session_subscriptions`.
4. If stream DO update fails: fail the request (no local write).
5. If local write fails after stream DO success: attempt rollback by removing
   the subscriber from stream DO; if rollback fails, record a repair log TODO.

### Unsubscribe
1. Session DO calls stream DO to remove `sessionId` from `stream_subscribers`.
2. On success, session DO deletes `streamId` from `session_subscriptions`.
3. If stream DO update fails: fail the request.

## Fan-Out Path (Per-Stream Gating)
On append to a stream DO, use `subscriber_count` to choose a fan-out path:
- `subscriber_count <= 200`: inline append envelope events to each session's
  fan-in stream.
- `subscriber_count > 200`: enqueue fan-out tasks (planned/optional queue).

Queue path (future): enqueue `{ sessionId, streamId, offset, type, payload }`
per subscriber and let a consumer append to session fan-in streams.

## Envelope Event Format
Each message in the fan-in stream is JSON:
```json
{
  "stream": "doc-abc",
  "offset": "0000000000000000_0000000000010000",
  "type": "data",
  "payload": { "op": "insert", "text": "hello" }
}
```
For binary payloads, encode to base64 and add `encoding: "base64"`.

Note: `offset` is the Durable Streams offset for the source stream.

## Client Consumption
Client opens one stream for the session:
```
GET /v1/stream/subscriptions/sess-123?offset=now&live=sse
```

SSE auth note: `EventSource` cannot set custom headers, so use cookie auth or a
short-lived signed token in the query string.

## Message Matching (TBD)
Does a message match a subscription? Not implemented yet. Stub:
```ts
function matchSubscription(message, subscriptionRule): boolean
```
TODOs:
- Define rule language (exact stream id vs prefix vs filter).
- Decide whether payload-level filtering is allowed.
- Decide caching strategy for compiled rules.

## Authorization Model
- Worker validates the caller can access the `sessionId` fan-in stream.
- Worker validates each subscription write against stream ACLs.
- Fan-in streams are private per session and should not be CDN-cached.

## Offset Semantics
- The fan-in stream has its own offsets independent of source streams.
- Source stream offsets are carried inside the envelope.
- Clients resume fan-in using the fan-in offset; clients can also resume a
  source stream using the embedded offset if needed.

## Failure Handling
- Fan-out should be idempotent where possible. Duplicate deliveries are allowed.
- Queue consumers should retry on failure. Duplicate writes are acceptable if
  clients dedupe on `{stream, offset}`.
- If fan-out falls behind, clients still have source streams for full replay.

## Implementation Notes
- Session fan-in streams are just regular Durable Streams.
- The dual index is required. Stream DO uses `stream_subscribers` for fan-out.
- Session DO uses `session_subscriptions` for listing.
- The queue option is recommended once fan-out cost is non-trivial.
