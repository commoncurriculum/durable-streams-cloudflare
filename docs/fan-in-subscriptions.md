# Fan-In Subscription Streams (V2 Concept)

## Overview
Fan-in streams aggregate updates from many underlying streams into a single
subscription stream per user or tenant. Clients open one SSE or long-poll
connection to the fan-in stream and receive multiplexed events with the source
stream id and offset.

This is an application-level pattern built on top of Durable Streams. It is not
part of the core protocol and is intended for v2 scale when clients subscribe
to hundreds of feeds.

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
- **Subscription registry**: persistent mapping of user or tenant to stream ids.
- **Fan-in stream**: a Durable Stream at `subscriptions/<subject>` that carries
  envelope events.
- **Envelope events**: JSON messages containing source stream id, source offset,
  event type, and payload.
- **Fan-out writer**: process that appends envelope events into fan-in streams.

## Data Model (D1)
```sql
CREATE TABLE subscriptions (
  subject_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (subject_id, stream_id)
);

CREATE INDEX subscriptions_by_stream
  ON subscriptions (stream_id);
```

`subject_id` is typically a user id or tenant id. Stream ids are the same ids
used by the core Durable Streams API.

## HTTP API (Worker)
1. `POST /v1/subscriptions`
Request body:
```json
{ "subjectId": "user-123", "streamId": "doc-abc" }
```
Behavior: authenticate, authorize, upsert into `subscriptions`.

2. `DELETE /v1/subscriptions`
Request body:
```json
{ "subjectId": "user-123", "streamId": "doc-abc" }
```
Behavior: authenticate, authorize, delete mapping.

3. `GET /v1/subscriptions/{subjectId}`
Returns a list of subscribed stream ids for debugging or UI.

## Fan-Out Pipeline Options

### Option A: Inline fan-out (simple)
On every append to a stream, the stream DO queries D1 for subscribed subjects
and appends an envelope event to each subject fan-in stream.

Pros: minimal infrastructure. Cons: append cost grows with subscribers.

### Option B: Queue-based fan-out (scalable)
On append, the stream DO writes a single event to a queue. A queue consumer
reads the event, queries subscriptions in D1, and appends envelope events into
fan-in streams.

Pros: isolates fan-out cost, smoother latency. Cons: extra infra and slight delay.

## Envelope Event Format
Each message in the fan-in stream is JSON:
```json
{
  "stream": "doc-abc",
  "offset": "0000000000003f10",
  "type": "data",
  "payload": { "op": "insert", "text": "hello" }
}
```
For binary payloads, encode to base64 and add `encoding: "base64"`.

## Client Consumption
Client opens one stream:
```
GET /v1/stream/subscriptions/user-123?offset=now&live=sse
Authorization: Bearer <token>
```
The client processes envelope events, optionally replays original streams for
verification or missing data.

## Authorization Model
- Worker validates the caller can access the `subjectId` fan-in stream.
- Worker validates each subscription write against stream ACLs.
- Fan-in streams are private per subject and should not be CDN-cached.

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
- Subject fan-in streams are just regular Durable Streams.
- The registry table is global and should live in D1 for queryability.
- The queue option is recommended once fan-out cost is non-trivial.
