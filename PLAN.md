# Durable Streams Elixir Server (MongoDB-first, pluggable storage) Plan

## Goals
- Implement the Durable Streams HTTP protocol in Elixir.
- Provide a storage behavior and adapter system, with MongoDB as the first backend.
- Reach conformance against the official Durable Streams test suites.
- Be CDN-friendly and production-safe from v0.1.

## Inputs from the Durable Streams repo (now confirmed locally)
- **Conformance suites**: `@durable-streams/server-conformance-tests` and `@durable-streams/client-conformance-tests`.
- **Server conformance CLI**: `npx @durable-streams/server-conformance-tests --run http://localhost:4437` and watch mode for development.
- **Test case sources**: YAML-based protocol test cases live under `packages/client-conformance-tests/test-cases/*` and are reused by the server conformance runner.
- **Implementation testing guide**: `IMPLEMENTATION_TESTING.md` describes durability, crash recovery, and concurrency tests not covered by black-box conformance.
- **Reference implementations**: Node reference server and the production-grade Caddy plugin.
- **Tooling**: CLI and Test UI for manual exploration and debugging.

## Phase 0: Repo Discovery and Source Alignment
- Read `PROTOCOL.md` and the server conformance README to lock down exact protocol requirements and test runner usage.
- Read the YAML conformance test cases under `packages/client-conformance-tests/test-cases/` to surface behavioral edge cases.
- Read `IMPLEMENTATION_TESTING.md` to plan durability/race-condition testing beyond conformance.
- Extract behavioral details from the Caddy plugin and Node server (offset format, chunking, live-mode behavior, header defaults).

Deliverables
- `docs/protocol-notes.md` summarizing required headers, status codes, offset semantics, caching rules, and live modes.
- `docs/conformance-notes.md` with exact CLI commands, environment requirements, and test-case map.
- `docs/implementation-testing-notes.md` mapping the durability/concurrency tests to MongoDB-specific risks.

## Phase 1: Library Architecture
- Create OTP app `durable_streams_server` with a clean module boundary:
- `DurableStreams.Protocol` for HTTP behavior and headers.
- `DurableStreams.StreamManager` for stream lifecycle operations.
- `DurableStreams.Storage` behavior and adapter registry.
- `DurableStreams.Offset` for opaque, lexicographically sortable offsets.
- `DurableStreams.Live` for long-poll waiters and SSE fan-out.
- `DurableStreams.Errors` for consistent protocol error mapping and status codes.
- `DurableStreams.SecurityHeaders` to satisfy conformance checks for security headers.

Deliverables
- `lib/durable_streams/storage/behaviour.ex` with a stable contract.
- `lib/durable_streams/protocol/plug.ex` with Plug or Phoenix integration hooks.

## Phase 2: Storage Behavior Definition
Define a minimal, testable storage contract that supports the protocol:
- `create_stream/2` and `get_stream/1` for metadata.
- `append/4` for atomic append with optional `Stream-Seq`.
- `read_range/3` for catch-up reads by offset.
- `tail_offset/1` and `earliest_offset/1` for retention handling.
- `delete_stream/1`.
- `set_ttl/2` and `set_expiry/2` if the protocol includes both.

Notes
- The storage layer must enforce strict ordering, idempotent create, and offset monotonicity.
- All side effects and validation should be centralized to keep HTTP handlers thin.
- Storage must expose enough info to satisfy conformance tests for ETag, byte-exactness, and read-your-writes.

## Phase 3: MongoDB Adapter
Data model
- `streams` collection for metadata, tail offset, content type, TTL/expiry, retention settings.
- `segments` collection for append-only data chunks with start/end offsets and seq.

Indexes
- `streams`: unique `stream_id`, plus TTL index if using expiration.
- `segments`: compound `(stream_id, start_offset)` and `(stream_id, end_offset)`.

Append strategy
- Use a transaction or atomic `findOneAndUpdate` to increment tail offset and record `Stream-Seq`.
- Insert segment only after metadata update succeeds or within a transaction.
- Ensure retry safety when clients re-send with `Stream-Seq`.

Read strategy
- Query segments by offset range, return contiguous data, enforce protocol chunking rules.
- Compute `Stream-Next-Offset` from segment boundaries.

Deliverables
- `lib/durable_streams/storage/mongodb.ex`.
- Integration tests running against a local MongoDB container.
- Durability tests derived from `IMPLEMENTATION_TESTING.md` (crash recovery, partial writes, concurrency).

## Phase 4: Protocol Handlers (HTTP)
Implement the protocol endpoints:
- `PUT` create stream with content type, TTL, expiry.
- `POST` append with required content type and non-empty body.
- `GET` catch-up reads with `Stream-Next-Offset`, `ETag`, `Stream-Up-To-Date`.
- `GET` live `long-poll` and `sse` modes.
- `HEAD` metadata.
- `DELETE` remove stream and segments.

Deliverables
- Handlers covering all status codes and headers.
- SSE streaming implementation using chunked responses.
- Security headers required by conformance tests applied to all responses.

## Phase 5: Live Modes and Fan-out
- Implement a lightweight in-memory pub/sub to wake long-poll waiters and SSE clients.
- Add backpressure and graceful disconnect handling.
- Provide a path for future distributed fan-out (Redis or MongoDB change streams).

Deliverables
- `DurableStreams.Live.LongPollManager` and `DurableStreams.Live.SSE` modules.
- SSE parser/format behavior verified against server conformance expectations (event boundaries, multi-line data, CRLF handling).

## Phase 6: Conformance and Benchmarking
- Integrate the official server conformance test suite as a `mix durable_streams.conformance` task invoking the CLI or JS API.
- Add CI to run conformance tests and unit tests.
- Optionally hook into the benchmarks package for basic performance baselines.

Deliverables
- `mix durable_streams.conformance` task.
- CI workflow for conformance and unit tests.
- `docs/conformance-notes.md` mapping test categories (SSE, long-poll, TTL/expiry, ETag/304, fuzzing, security headers).

## Phase 7: Documentation and Examples
- Provide minimal usage docs for Plug/Phoenix integration.
- Document MongoDB setup, indexes, and operational limits.
- Provide a tiny demo app with a stream append and live read.

Deliverables
- `README.md` usage section.
- `examples/basic_server`.

## Risks and Open Questions
- Offset encoding must be lexicographically sortable and opaque; choose and document the format early.
- MongoDB transaction cost vs throughput: validate performance under append-heavy workloads.
- Long-poll timeout semantics and SSE reconnection behavior must match conformance tests.
- TTL/expiry semantics need a precise mapping to MongoDB TTL indexes.
- Conformance tests include fuzzing and security-focused cases; ensure header parsing and error handling are strict.

## Validation Checklist
- Pass all server conformance tests.
- Long-poll and SSE behavior stable under client churn.
- Correct handling of `Stream-Seq` conflict errors.
- Retention and `410 Gone` semantics enforced.
- CDN caching for catch-up reads verified with `ETag` and `Cache-Control`.
- Implementation tests from `IMPLEMENTATION_TESTING.md` pass on crash recovery and concurrency scenarios.
