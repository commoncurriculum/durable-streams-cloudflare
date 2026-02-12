# Agent Task: Fix Close Semantics in appendStream

## Context

You are working on `packages/server/src/http/v1/streams/append/index.ts` — the `appendStream` function.

Run conformance tests with: `pnpm -C packages/server run conformance`
Run unit tests with: `pnpm -C packages/server run test:unit`
Run typecheck with: `pnpm -C packages/server run typecheck`
Run lint with: `pnpm -C packages/server run lint`

Read `CLAUDE.md` at the repo root for project conventions.

## The Problem

10 conformance tests fail because `appendStream` handles already-closed streams incorrectly. The current code at the top of the function does:

```ts
if (!meta) throw new HttpError(404, "stream not found");
if (meta.closed) throw new HttpError(409, "stream is closed");
```

This early `meta.closed` check rejects ALL requests to closed streams with a bare 409. But the protocol requires more nuanced behavior:

### Failure 1: `close-idempotent` — expected 204, got 409

Closing an already-closed stream with empty body + `Stream-Closed: true` should return **204** (idempotent close), not 409.

### Failure 2: `close-only-ignores-content-type` — expected 204, got 409

Close-only (empty body + `Stream-Closed: true`) with a mismatched Content-Type should still succeed with **204**. Content-Type validation should be skipped for close-only operations.

### Failure 3: `append-to-closed-stream-409` — expected `Stream-Closed: true` header, got null

Appending to a closed stream correctly returns 409, but the response is **missing the `Stream-Closed: true` header**. The test expects the 409 response to include this header.

### Failure 4: `append-and-close-to-closed-stream-409` — expected `Stream-Closed: true` header, got null

Same as above but for POST with body + `Stream-Closed: true` to an already-closed stream.

### Failure 5: `idempotent-close-duplicate-returns-204` — expected 204, got 409

When a producer closes a stream, then sends the exact same close request (same producer tuple), it should return **204** (duplicate detection). Currently returns 409 because of the early `meta.closed` check.

### Failure 6: `idempotent-close-different-tuple-returns-409` — expected `Stream-Closed: true` header, got null

A different producer trying to close an already-closed stream should get 409, but the response needs the `Stream-Closed: true` header.

### Failure 7: `idempotent-close-different-seq-returns-409` — expected `Stream-Closed: true` header, got null

Same producer, different seq trying to close → 409, but needs `Stream-Closed: true` header.

### Failure 8: `idempotent-close-only-duplicate-returns-204` — expected 204, got 409

Duplicate close-only (no body, same producer tuple) should return **204**.

### Failure 9: `409-includes-stream-offset` — expected `Stream-Closed: true` header, got null

The 409 response for appending to a closed stream must include `Stream-Closed: true` header.

### Failure 10: `close-with-different-body-dedup` — expected 204, got 409

Retrying a close with a different body but same producer tuple should deduplicate to the original and return **204**.

## The Fix

The fix is in `packages/server/src/http/v1/streams/append/index.ts`. You need to restructure the `meta.closed` handling. Instead of the early blanket 409, the logic should be:

### Step 1: Remove the early `if (meta.closed) throw new HttpError(409, "stream is closed")` check.

### Step 2: After confirming the stream exists, handle `meta.closed` with nuance:

**If `meta.closed` AND the request is a close-only (empty body + `closeStream` flag):**

- Skip content-type validation (close-only ignores content-type)
- If there's a producer, run `evaluateProducer`:
  - If `duplicate` → return 204 with appropriate headers (idempotent dedup)
  - If `error` → throw the error (e.g., stale epoch → 403)
  - If `none` or new producer → return 204 (idempotent close, stream already closed)
- If no producer → return 204 (idempotent close)
- All 204 responses should include `Stream-Closed: true` and `Stream-Next-Offset` headers

**If `meta.closed` AND the request is a close with body (`closeStream` flag + non-empty payload):**

- If there's a producer, run `evaluateProducer`:
  - If `duplicate` → return 204 with headers (dedup, the original close had body)
  - If `error` → throw the error
  - Otherwise → throw 409 with `Stream-Closed: true` and `Stream-Next-Offset` headers
- If no producer → throw 409 with `Stream-Closed: true` and `Stream-Next-Offset` headers

**If `meta.closed` AND the request is a regular append (no `closeStream` flag):**

- Throw 409 but include `Stream-Closed: true` and `Stream-Next-Offset` headers in the response

### Step 3: Build a proper 409 response for closed streams

Instead of `throw new HttpError(409, "stream is closed")`, build a Response with headers:

```ts
const nextOffset = await ctx.encodeTailOffset(streamId, meta);
const headers = baseHeaders({
  [HEADER_STREAM_NEXT_OFFSET]: nextOffset,
  [HEADER_STREAM_CLOSED]: "true",
});
throw new HttpError(
  409,
  "stream is closed",
  new Response(JSON.stringify({ error: "stream is closed" }), {
    status: 409,
    headers,
  }),
);
```

### Step 4: Content-type validation should only happen when the stream is NOT already closed, OR when the request has a body (not close-only).

The existing content-type check at step 3a should be moved AFTER the closed-stream handling, or guarded so it doesn't run for close-only operations on already-closed streams.

## Key Files

- `packages/server/src/http/v1/streams/append/index.ts` — THE main file to edit
- `packages/server/src/http/shared/errors.ts` — `HttpError` class, `errorToResponse`
- `packages/server/src/http/shared/headers.ts` — `HEADER_STREAM_CLOSED`, `HEADER_STREAM_NEXT_OFFSET`, `baseHeaders`
- `packages/server/src/http/v1/streams/shared/producer.ts` — `evaluateProducer`

## Important Constraints

- **Do NOT add `blockConcurrencyWhile` back into `appendStream`.** It was deliberately removed. The callers handle BCW. See the commit message and `append/http.ts` for context.
- **Do NOT change the function signature** of `appendStream`. It still returns `Promise<ExecuteAppendResult>` and throws `HttpError` on errors.
- When throwing HttpError for closed-stream 409s, use the 3-arg form: `new HttpError(409, "stream is closed", prebuiltResponse)` so `errorToResponse` returns the response with the correct headers.
- Run `pnpm -C packages/server run conformance` to verify. Target: all 10 close-related tests passing + the Stream-Seq ordering fix below, no regressions in the other 226 passing tests.
- Run `pnpm -C packages/server run test:unit` to verify no unit test regressions.
- Run `pnpm -C packages/server run typecheck` and `pnpm -C packages/server run lint` — both must be clean.

## Bonus Fix (also in appendStream): Producer dedup must run BEFORE Stream-Seq validation

### Failure 11: `producer duplicate should return 204 even with Stream-Seq header` — expected 204, got 409

When a producer sends a duplicate request (same producer-id/epoch/seq) that also includes a `Stream-Seq` header, the server should detect the duplicate first and return **204**. Currently step 3b (Stream-Seq validation) runs before step 4 (producer dedup), so Stream-Seq rejects with 409 before the dedup logic gets a chance.

**The fix**: In `appendStream`, move step 4 (producer dedup / `evaluateProducer`) BEFORE step 3b (Stream-Seq validation via `validateStreamSeq`). If the producer is a duplicate, return 204 immediately — don't even check Stream-Seq. Only validate Stream-Seq for non-duplicate writes.

This is a simple reordering of the existing checks in `appendStream`. Since you're already restructuring the closed-stream handling in that function, fold this in.
