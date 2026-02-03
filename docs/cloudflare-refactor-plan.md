# Cloudflare Durable Streams POC Refactor Plan

## Goals
- Preserve full protocol compliance (server conformance 239/239).
- Separate protocol logic, storage, and transport concerns.
- Keep tests accurate with real storage (no stubs or mock storage layers).
- Keep the Worker/Durable Object deployable with minimal configuration changes.

## Non-Goals
- Changing the on-wire protocol or response semantics.
- Introducing alternate storage backends in this refactor (D1 + R2 stay primary).
- Reducing correctness checks to optimize perf.

## Current Baseline
- POC passes the server conformance suite locally with `wrangler dev --local` and D1/R2.
- Logic is concentrated in `poc/cloudflare/src/stream_do.ts` and `poc/cloudflare/src/worker.ts`.

## Phase 0: Baseline Capture
- Record current conformance run command and output.
- Capture current behavior notes (SSE, long-poll, TTL/expiry, producer semantics).
- Freeze acceptance criteria: conformance must remain green after each phase.
- Add a small “characterization” suite that hits the live worker to lock in
  response semantics for a few high-risk flows (SSE CRLF handling, long-poll
  timeout headers, producer fencing).
- Add a lightweight perf check (local) to detect latency regressions (e.g. 95p
  under target in dev for small writes/reads).
- Capture failure-mode expectations (DO restart mid-append; in-flight requests).
- Document snapshot/retention policy for R2 (creation cadence, rotation, TTL).

Deliverables
- `docs/cloudflare-refactor-plan.md` (this plan).
- `docs/cloudflare-poc-status.md` with current command set and conformance pass note.

## Phase 1: Module Boundaries
- Split the monolithic Durable Object into focused modules.
- Keep the public HTTP behavior unchanged.
- Add a small config module for limits (payload size, chunk size, timeouts).

Proposed module layout
- `src/protocol/headers.ts` – constants, normalize helpers, security headers.
- `src/protocol/offsets.ts` – encode/decode, validation, `offset=now` rules.
- `src/protocol/errors.ts` – consistent error responses.
- `src/protocol/json.ts` – JSON batching rules and SSE JSON formatting.
- `src/protocol/limits.ts` – payload/chunk/timeout constants (configurable).
- `src/live/long_poll.ts` – waiter queue and timeout logic.
- `src/live/sse.ts` – SSE event formatting and safe line encoding.
- `src/storage/storage.ts` – storage interface contract.
- `src/storage/d1.ts` – D1 implementation (current behavior).
- `src/engine/stream.ts` – core stream operations driven by storage.
- `src/engine/producer.ts` – producer fencing/epoch/seq logic.
- `src/engine/close.ts` – stream close semantics.
- `src/http/router.ts` – method dispatch (called by `StreamDO.fetch`).
 - `src/http/auth.ts` – auth/tenant boundary enforcement (Worker vs DO).
 - `src/observability/metrics.ts` – minimal timing/log hooks (optional).

Deliverables
- `stream_do.ts` becomes a thin shell that wires storage + engine + live helpers.
- `worker.ts` remains unchanged except imports.

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

Deliverables
- Isolated SSE and long-poll helpers.
- Zero changes to observed protocol output.

## Phase 5: Test Strategy (No Stubs)
- Keep all integration tests running against real local bindings.
- Avoid mock storage.

Approach
- Continue using `wrangler dev --local` for conformance suite.
- Add integration tests that spin a local worker and use real D1/R2.
- For pure helpers (offset encoding, JSON batching, SSE formatting), add unit
  tests that do not hit storage and do not use mocks.

Deliverables
- `pnpm run conformance` remains the gate.
- Optional `pnpm run test:integration` that uses local Wrangler bindings.

## Phase 6: Docs and Ops
- Document the module layout and extension points.
- Keep usage docs minimal and accurate.

Deliverables
- `docs/cloudflare-architecture.md`.
- Update `poc/cloudflare/README.md` with module layout and test commands.

## Milestones
1. **Refactor skeleton** in place, conformance still green.
2. **Storage interface** extracted, engine in place, conformance green.
3. **Live modes isolated**, conformance green.
4. **Docs updated**.

## Acceptance Criteria
- `pnpm run conformance` passes (239/239) after each phase.
- No mock storage layers introduced.
- Worker behavior remains protocol-identical (headers, status codes, SSE events).
