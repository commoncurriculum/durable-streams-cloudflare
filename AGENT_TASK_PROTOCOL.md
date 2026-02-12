# Agent Task: Fix Protocol Edge Cases (2 conformance failures)

## Context

Run conformance tests with: `pnpm -C packages/server run conformance`
Run unit tests with: `pnpm -C packages/server run test:unit`
Run typecheck with: `pnpm -C packages/server run typecheck`
Run lint with: `pnpm -C packages/server run lint`

Read `CLAUDE.md` at the repo root for project conventions.

These 2 failures are independent of the 11 close-semantics/ordering failures being fixed separately in `packages/server/src/http/v1/streams/append/index.ts`. **Do NOT edit `append/index.ts`** — another agent is working on that file.

## Failure 1: `should reject empty offset parameter` — expected 400, got 200

When a GET request includes an empty offset parameter (`?offset=`), the server should return **400**. Currently it returns 200.

The fix is in the **read/GET path**. Look at how the offset parameter is parsed and validated. An empty string `""` is being treated as valid when it should be rejected.

### Where to look

- `packages/server/src/http/v1/streams/read/http.ts` — the HTTP handler for GET requests
- `packages/server/src/http/v1/streams/read/index.ts` — read logic
- `packages/server/src/http/v1/streams/shared/stream-offsets.ts` — offset parsing/validation (`resolveOffsetParam` or similar)
- The edge router in `packages/server/src/http/router.ts` or similar — may validate query params before routing to DO

The fix: when `offset` query param is present but empty string, return 400. Check where the offset is first extracted from the URL and add validation there.

## Failure 2: `should handle large payload appropriately` — expected one of [200, 204, 413], got 500

When a very large payload is POSTed, the conformance test expects the server to return 200, 204, or 413 (payload too large). Instead, it returns 500.

This is likely a `blockConcurrencyWhile` issue in a **different code path** than `appendStream` (which was already fixed). Or it could be that the large payload causes an unhandled error somewhere in the request processing pipeline before `appendStream` is reached.

### Where to look

- `packages/server/src/http/v1/streams/append/http.ts` — the HTTP handler wraps `appendStream` in BCW with try/catch. Check if reading a very large `request.arrayBuffer()` could throw before entering BCW.
- `packages/server/src/http/v1/streams/shared/body.ts` — `validateBodySize` function
- The edge router — does it have size limits or error handling for large requests?
- Hono's `onError` handler in `packages/server/src/http/v1/streams/index.ts` — does it catch errors from reading the request body?

The fix: ensure any error from processing a large payload (whether from `arrayBuffer()`, body validation, or Cloudflare's own limits) results in 413 rather than an unhandled 500. The try/catch in `appendStreamHttp` may need to move to cover the request body reading step, or the Hono `onError` handler needs to detect payload-too-large conditions.

## Important Constraints

- **Do NOT edit `packages/server/src/http/v1/streams/append/index.ts`** — another agent owns that file.
- Run conformance tests to verify your fixes. Target: your 2 failures fixed, no regressions.
- Run unit tests, typecheck, and lint — all must pass.
- Keep changes minimal and focused.
