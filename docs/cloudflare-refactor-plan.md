# Cloudflare Durable Streams POC Refactor Plan

## Goals
- Preserve full protocol compliance (server conformance 239/239).
- Separate protocol logic, storage, and transport concerns.
- Keep tests accurate with real storage (no stubs or mock storage layers).
- Keep the Worker/Durable Object deployable with minimal configuration changes.
- Align core behavior with the Node + Caddy reference implementations where
  it improves standardization (cursor jitter, registry stream, offsets, etc).

## Non-Goals
- Changing the on-wire protocol or response semantics.
- Introducing alternate storage backends in this refactor (D1 + R2 stay primary).
- Reducing correctness checks to optimize perf.

## Progress (as of 2026-02-03)
- Extracted protocol helpers into `src/protocol/*` (headers/offsets/cursor/encoding/expiry/etag/validation).
- Added `src/protocol/errors.ts`, `src/protocol/json.ts`, and `src/protocol/limits.ts`.
- Extracted live helpers into `src/live/long_poll.ts` and `src/live/sse.ts`.
- Added `src/storage/storage.ts` interface + `src/storage/d1.ts` implementation.
- Extracted producer parsing/evaluation into `src/engine/producer.ts`.
- Extracted core stream operations into `src/engine/stream.ts`.
- Extracted close-only semantics into `src/engine/close.ts`.
- Randomized cursor jitter implemented to match reference behavior.
- Standardized SSE encoding header to `Stream-SSE-Data-Encoding`.
- Added CORS handling and exposed Stream/Producer headers in `worker.ts`.
- Added registry stream hooks (`__registry__`) for create/delete events.
- R2 snapshots now use length-prefixed segment framing (Caddy parity).
- R2 snapshot keys now base64url-encode stream ids (safer paths, CDN-friendly).
- Producer state TTL cleanup (7d) implemented with `last_updated` (on access).
- Closed-by producer tuple persisted for idempotent close-only retries.
- Introduced HTTP router + handler modules (mutation/catchup/realtime); `stream_do.ts` slimmed.
- Stream deletion now wakes long-poll waiters and closes active SSE clients.
- Content-Length mismatches now rejected to prevent truncated writes.
- Conformance suite remains green (239/239).

## Current Baseline
- POC passes the server conformance suite locally with `wrangler dev --local` and D1/R2.
- Logic is concentrated in `poc/cloudflare/src/stream_do.ts` and `poc/cloudflare/src/worker.ts`.

## Phase 0: Baseline Capture
- Record current conformance run command and output.
- Capture current behavior notes (SSE, long-poll, TTL/expiry, producer semantics).
- Freeze acceptance criteria: conformance must remain green after each phase.
- Compare against reference implementations and log any intentional deltas:
  - Cursor jitter (randomized 1–3600s on collision).
  - Registry stream (`__registry__`) for create/delete events.
  - Offset format and rotation friendliness.
  - Segment framing for cold storage reads.
- Add a small “characterization” suite that hits the live worker to lock in
  response semantics for a few high-risk flows (SSE CRLF handling, long-poll
  timeout headers, producer fencing).
- Add a lightweight perf check (local) to detect latency regressions (e.g. 95p
  under target in dev for small writes/reads).
  - Note: CF budget target is ~10ms server-side (end-to-end target is 50ms).
- Capture failure-mode expectations (DO restart mid-append; in-flight requests).
- Document snapshot/retention policy for R2 (creation cadence, rotation, TTL).

Deliverables
- `docs/cloudflare-refactor-plan.md` (this plan).
- `docs/cloudflare-poc-status.md` with current command set and conformance pass note.
Current status
- `docs/cloudflare-poc-status.md` added with local command set + test status.

## Phase 1: Module Boundaries
- Split the monolithic Durable Object into focused modules.
- Keep the public HTTP behavior unchanged.
- Add a small config module for limits (payload size, chunk size, timeouts).

Proposed module layout
- `src/protocol/headers.ts` – constants, normalize helpers, security headers.
- `src/protocol/offsets.ts` – encode/decode, validation, `offset=now` rules.
- `src/protocol/cursor.ts` – cursor calculation and collision jitter.
- `src/protocol/errors.ts` – consistent error responses.
- `src/protocol/json.ts` – JSON batching rules and SSE JSON formatting.
- `src/protocol/limits.ts` – payload/chunk/timeout constants (configurable).
- `src/live/long_poll.ts` – waiter queue and timeout logic.
- `src/live/sse.ts` – SSE event formatting and safe line encoding.
- `src/storage/storage.ts` – storage interface contract.
- `src/storage/d1.ts` – D1 implementation (current behavior).
- `src/storage/segments.ts` – segment framing + R2 key encoding helpers.
- `src/engine/stream.ts` – core stream operations driven by storage.
- `src/engine/producer.ts` – producer fencing/epoch/seq logic.
- `src/engine/close.ts` – stream close semantics.
- `src/http/router.ts` – method dispatch (called by `StreamDO.fetch`).
- `src/http/handlers/` – hybrid structure: verb entrypoints grouped by behavior.
  - `catchup.ts` – `handleGet` + `handleHead` (offsets, etag, cache headers).
  - `realtime.ts` – `handleSse` + `handleLongPoll` (live orchestration).
  - `mutation.ts` – `handlePut` + `handlePost` + `handleDelete`.
- `src/http/auth.ts` – auth/tenant boundary enforcement (Worker vs DO).
- `src/http/cors.ts` – CORS + expose headers at Worker boundary.
- `src/observability/metrics.ts` – minimal timing/log hooks (optional).

Deliverables
- `stream_do.ts` becomes a thin shell that wires storage + engine + live helpers.
- `worker.ts` remains unchanged except imports.
Current status
- `headers.ts`, `offsets.ts`, `cursor.ts`, `encoding.ts`, `expiry.ts`, `etag.ts`,
  `validation.ts`, `errors.ts`, `json.ts`, and `limits.ts` extracted.
- `live/long_poll.ts` and `live/sse.ts` extracted.
- `storage/storage.ts` and `storage/d1.ts` extracted; `stream_do.ts` now uses
  D1Storage for all DB access.
- `engine/producer.ts` extracted; `stream_do.ts` delegates producer parsing +
  validation there.
- `engine/stream.ts` extracted; `stream_do.ts` delegates append/read/headers logic.
- `engine/close.ts` extracted; `stream_do.ts` delegates close-only logic there.

## Phase 2: Storage Interface (D1-First)
- Define the exact storage surface the engine needs.
- Keep all reads/writes serialized via DO concurrency control.

Storage interface outline
- `getStream(streamId)` -> metadata or null.
- `createStream(streamId, meta)` -> 201/200 conflict semantics handled by engine.
- `append(streamId, appendSpec)` -> atomic append result with new tail offset.
- `readRange(streamId, offset, limitBytes)` -> chunks + up-to-date flags.
- `deleteStream(streamId)` -> removes metadata + ops.
- `upsertProducer(streamId, producerState)`.
- `getProducer(streamId, producerId)`.
- `markClosed(streamId, atOffset)`.
- `recordSnapshot(streamId, r2Key, range)`.
- `recordSegment(streamId, r2Key, range, format)` -> segment index for R2 reads.

Deliverables
- `src/storage/storage.ts` with typed interface.
- `src/storage/d1.ts` implementing it with current SQL.

## Phase 3: Engine Consolidation
- Move protocol rules out of storage.
- Keep storage free of HTTP concepts and header logic.
- Centralize concurrency control here: keep `blockConcurrencyWhile` boundaries
  in the engine/router layer (not scattered across storage modules).

Core engine responsibilities
- Validate request semantics (content-type, empty body, TTL/expiry rules).
- Producer fencing/dup logic.
- JSON batching rules for POST body.
- Offset semantics and read ranges.
- Stream close semantics and idempotent close.
- Registry stream hooks (create/delete emit to `__registry__`).
- Cursor collision jitter aligned with reference implementation.
- R2 key encoding for cold storage objects.

Deliverables
- `src/engine/stream.ts`, `src/engine/producer.ts`, `src/engine/close.ts`.
- `stream_do.ts` delegates to engine + storage + live helpers.

## Phase 4: Live Modes
- Keep SSE and long-poll stable and safe.
- Ensure SSE control/data events are emitted atomically.

Work items
- Extract SSE formatting into `src/live/sse.ts`.
- Extract waiter queue into `src/live/long_poll.ts`.
- Add small unit tests for pure formatting functions (no storage mocking).
- Ensure SSE data line encoding matches the reference safety rules.

Deliverables
- Isolated SSE and long-poll helpers.
- Zero changes to observed protocol output.

## Phase 4.5: Reference Parity Improvements (Cloudflare-Specific)
- Add CORS + exposed headers in `worker.ts` (Stream-* and Producer-* headers). (done)
- Add producer state TTL cleanup (on access; periodic optional). (done)
- Track `closed_by` producer tuple for idempotent close-only retries (Caddy/Node parity). (done)
- Adopt randomized cursor jitter (1–3600s) for CDN collision handling. (done)
- Add registry stream (`__registry__`) for create/delete discovery. (done)
- Encode R2 keys using base64url path encoding for safety. (done)
- Evaluate offset format shift to `readSeq_byteOffset` if we decide to support
  segment rotation in R2 (document if we intentionally keep hex offsets).
- Implement segment framing for cold storage (length‑prefixed messages). (done for snapshots)

## Phase 5: Test Strategy (No Stubs)
- Keep all integration tests running against real local bindings.
- Avoid mock storage.

Approach
- Continue using `wrangler dev --local` for conformance suite.
- Add integration tests that spin a local worker and use real D1/R2.
- Add a perf smoke test that reports p50/p95 and only enforces budgets when
  explicitly enabled (CI or local perf runs).
- For pure helpers (offset encoding, JSON batching, SSE formatting), add unit
  tests that do not hit storage and do not use mocks.
- Add implementation tests (white-box) focused on durability and race
  conditions, adapted from `IMPLEMENTATION_TESTING.md`.

Deliverables
- `pnpm run conformance` remains the gate.
- `pnpm run test:implementation` running against local Wrangler bindings.
- `pnpm run perf` for local perf smoke runs.

## Phase 5.5: Implementation Testing (Durability & Races)
Informed by `IMPLEMENTATION_TESTING.md`, add a second suite aimed at internal
failure modes that conformance can’t exercise.

Targets (Cloudflare-specific)
- **Crash recovery / restart safety**
  - Simulate DO restarts mid-stream and ensure offsets + data remain consistent.
  - Repeated restart cycles should remain idempotent (no dupes/rewinds).
  - Producer idempotency should hold across restarts (duplicate seqs ignored).
  - SSE reconnects should recover cleanly after worker restarts.
  - Aborted appends should not persist partial data.
- **Concurrent access**
  - Multiple readers during append should see either before or after state,
    never partial data (especially for JSON streams).
  - Concurrent producers with gaps/duplicates should return correct headers.
- **Resource cleanup**
  - Delete stream while long-poll/SSE active; clients should close cleanly.
  - Ensure producers table is pruned per TTL without affecting active producers.
- **Cold storage correctness**
  - If R2 segment read fails or is truncated, fallback to last valid boundary
    and return consistent data (no corrupted bytes).
  - Segment index should match offsets exactly after compaction.
- **Property/invariant checks**
  - Randomized operation sequences (append/read/delete/close) maintain
    monotonic offsets and data immutability.

Deliverables
- `pnpm run test:implementation` running against local `wrangler dev --local`.
- Clear separation from conformance tests (no mocks, real D1/R2).
Current status
- Added implementation tests for delete cleanup (SSE/long-poll) + concurrent appends.
- Added restart tests covering persistence + producer idempotency across worker restarts.
- Implementation tests now spin up a local worker automatically when no
  `IMPLEMENTATION_TEST_URL` is provided.
- Added tests for aborted append safety and SSE reconnect after restart.

## Phase 6: Docs and Ops
- Document the module layout and extension points.
- Keep usage docs minimal and accurate.

Deliverables
- `docs/cloudflare-architecture.md`.
- Update `poc/cloudflare/README.md` with module layout and test commands.
- Document registry stream behavior and header exposure for browser clients.
Current status
- `docs/cloudflare-architecture.md` added.
- Registry stream + CORS header exposure documented in `poc/cloudflare/README.md`.

## Milestones
1. **Refactor skeleton** in place, conformance still green.
2. **Storage interface** extracted, engine in place, conformance green.
3. **Live modes isolated**, conformance green.
4. **Docs updated**.

## Acceptance Criteria
- `pnpm run conformance` passes (239/239) after each phase.
- No mock storage layers introduced.
- Worker behavior remains protocol-identical (headers, status codes, SSE events).
