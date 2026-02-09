# Documentation Accuracy Review

Reviewed: chapters 00 through 10 in `docs/` against the current codebase (commit `dde43ee`).

## Summary of What Was Checked

- File paths referenced in all chapters vs actual filesystem
- SQL schemas in Chapter 1 and Chapter 9 vs `packages/core/src/storage/queries.ts` and `packages/subscription/src/session/do.ts` / `packages/subscription/src/subscriptions/do.ts`
- Constants (timeouts, TTLs, thresholds) in Chapters 1, 5, 6, 7 vs `packages/core/src/protocol/limits.ts`
- Cache-Control header values in Chapter 5 vs `packages/core/src/protocol/expiry.ts` and `packages/core/src/http/handlers/realtime.ts`
- Architectural claims (DO hibernation, WebSocket bridge, edge caching) vs source code in `create_worker.ts`, `durable_object.ts`, `realtime.ts`, `read.ts`
- Cross-references between chapters
- WsAttachment type vs source
- Edge cache store guards vs `create_worker.ts`
- Subscription data model in Chapter 9 vs actual subscription package schema

---

## Inaccuracies Found

### 1. Chapter 1 -- `content_strategy.ts` does not exist

**Location**: Chapter 1, "Stream Logic" table, row for `content_strategy.ts`.

**Claim**: `content_strategy.ts` handles "JSON vs binary serialization."

**Actual**: No file named `content_strategy.ts` exists anywhere under `packages/core/src/stream/`. The JSON vs binary logic lives in `packages/core/src/protocol/headers.ts` (`isJsonContentType`, `isTextual`) and `packages/core/src/protocol/json.ts`. The grep for `content_strategy` returned no results in the entire core source tree.

**Impact**: A developer looking for this file would not find it.

---

### 2. Chapter 1 -- `__registry__` stream does not exist in the codebase

**Location**: Chapter 1, final section "Registry Stream."

**Claim**: "The worker emits create/delete events to a system stream (`__registry__`) for clients that need discovery or monitoring."

**Actual**: There is no reference to `__registry__` anywhere in `packages/core/src`. The REGISTRY binding is a KV namespace used for JWT signing secrets and stream public/private flags -- it is not a Durable Stream. There is no system stream for create/delete events.

**Impact**: Developers would search for a registry stream feature that does not exist.

---

### 3. Chapter 1 -- SQL schema is missing the `public` column on `stream_meta`

**Location**: Chapter 1, SQL schema for `stream_meta`.

**Claim**: The schema lists 16 columns, ending at `closed_by_seq`.

**Actual**: `packages/core/src/storage/queries.ts` (line 76) has a migration that adds `public INTEGER NOT NULL DEFAULT 0` to `stream_meta`. The column is actively used for public stream bypass in the auth path. The documented schema is incomplete.

**Impact**: Minor -- this is an internal-only column and is added via migration, but it could confuse someone reading the schema alongside the actual `insertStream` call (which inserts 17 columns including `public`).

---

### 4. Chapter 5 -- Long-poll 204 timeout `Cache-Control` value is wrong

**Location**: Chapter 5, "Cache-Control Headers" table, row for "Long-poll 204 (timeout)."

**Claim**: `Cache-Control: public, max-age=20`

**Actual**: In `packages/core/src/http/handlers/realtime.ts`, the timeout path (line 376) explicitly sets `Cache-Control: no-store`, not `public, max-age=20`. The code:
```ts
if (timedOut) {
    // ...
    headers.set("Cache-Control", "no-store");
    return new Response(null, { status: 204, headers });
}
```

Similarly, the "no data after wait" path (line 393) also sets `no-store`.

The same error appears in **Chapter 6**, in the "Long-Poll Response Headers" section, which shows `Cache-Control: public, max-age=20` for the 204 timeout response.

**Impact**: Significant -- this is a correctness detail. The docs claim 204s have `max-age=20` which would make it seem like they could be cached client-side. The actual `no-store` is the correct behavior to prevent tight retry loops.

---

### 5. Chapter 1 -- `blockConcurrencyWhile` usage is not accurate for all writes

**Location**: Chapter 1, "Request Flow > Writes" step 2.

**Claim**: "StreamDO runs the handler inside `blockConcurrencyWhile()` for single-writer ordering."

**Actual**: `blockConcurrencyWhile` is used in the DO constructor (for schema init) and in the individual write handlers (`handlePut`, `handlePost`, `handleDelete` in `write.ts`). The DO's `routeStreamRequest` method itself does NOT wrap the entire call in `blockConcurrencyWhile` -- only the specific write handlers do. Read handlers run concurrently. This is architecturally important because reads are not blocked by writes.

**Impact**: Minor -- the claim is directionally correct (writes do use `blockConcurrencyWhile`) but could mislead someone into thinking reads are also serialized.

---

### 6. Chapter 7 -- Line number references are stale

**Location**: Chapter 7, "Relevant Code" section.

**Claims**:
- "Edge Worker cache logic: `packages/core/src/http/create_worker.ts` (lines 336-475)"
- "In-flight coalescing: `packages/core/src/http/create_worker.ts` (lines 371-416, `inFlight` Map)"
- "Long-poll cache headers: `packages/core/src/http/handlers/realtime.ts` (line 295)"

**Actual**: The file is 526 lines. The edge cache section starts around line 319. The inFlight coalescing section starts around line 380. Long-poll cache headers are around line 296. These are off by 15-20 lines, likely from code changes since the doc was written.

**Impact**: Minor nuisance -- line numbers in docs go stale quickly. Consider removing them or using region markers instead.

---

### 7. Chapter 9 -- Subscription SQL schema does not match actual implementation

**Location**: Chapter 9, "Data Model" section.

**Claim**: Two tables `session_subscriptions` and `session_offsets` with columns including `user_id`, `subscription_epoch`, `expires_at`, `last_offset`, `updated_at`.

**Actual**: The subscription package has a completely different data model:
- `SessionDO` (`packages/subscription/src/session/do.ts`) has a `subscriptions` table with only `stream_id TEXT PRIMARY KEY` and `subscribed_at INTEGER NOT NULL`. No `user_id`, no `subscription_epoch`, no `expires_at`, no `last_offset`.
- `SubscriptionDO` (`packages/subscription/src/subscriptions/do.ts`) has a `subscribers` table with `session_id TEXT PRIMARY KEY` and `subscribed_at INTEGER NOT NULL`, plus a `fanout_state` table.
- There is no `session_offsets` table anywhere in the codebase.
- There is no `subscription_epoch` column anywhere.
- There is no `user_id` column anywhere in the subscription tables.

**Impact**: High -- Chapter 9 describes a design that was never implemented as specified. The actual implementation is a simpler dual-DO model (SessionDO stores which streams a session subscribes to; SubscriptionDO stores which sessions subscribe to a stream). Anyone using Chapter 9 as a reference for the actual data model would be completely misled.

---

### 8. Chapter 9 -- API sketch does not match actual routes

**Location**: Chapter 9, "Minimal API Sketch" section.

**Claim**: Lists `POST /v1/sessions`, `POST /v1/subscriptions`, `DELETE /v1/subscriptions`, `POST /v1/heartbeat`, `GET /v1/session-offsets/<sessionId>`.

**Actual**: Looking at `packages/subscription/src/http/routes/`, the actual routes include `session.ts`, `subscribe.ts`, `publish.ts`. There is no heartbeat endpoint and no session-offsets endpoint. The subscription worker has a publish route (`POST /v1/:projectId/publish/:streamId`) that does not appear in the sketch at all.

**Impact**: High -- the API sketch describes a different system than what was built. The pub/sub model in the actual implementation uses queue-based fan-out via a publish endpoint, not heartbeat-based offset tracking.

---

### 9. Chapter 1 -- `hono.ts` described as "CORS helpers" but no Hono router is used

**Location**: Chapter 1, "Edge Layer" table.

**Claim**: `hono.ts` provides "CORS helpers."

**Actual**: The file at `packages/core/src/http/hono.ts` does exist and does export CORS-related functions (`applyCorsHeaders`). The description is accurate, though the name `hono.ts` is potentially misleading since the core package does NOT use Hono for routing (the subscription package does). The core package uses a custom router in `router.ts`. The name `hono.ts` is a historical artifact.

**Impact**: Negligible -- the description is technically correct but the filename is confusing.

---

## Claims That Could Not Be Fully Verified

### A. Cost figures in Chapter 2

The Cloudflare pricing rates, cost calculations, and monthly estimates are based on external Cloudflare pricing pages. These could not be verified against the codebase and may be outdated if Cloudflare has changed pricing.

### B. CDN MISS investigation numbers in Chapter 7

The test results (HIT rates, latencies, PoP distribution) are empirical observations from specific test runs. These cannot be verified from the codebase -- they are historical records.

### C. Chapter 10 (Fan-In Streams) is explicitly marked "Planned (not implemented)"

This is a design document, not a description of existing code. No verification was attempted since it correctly states it is not implemented.

---

## Verified as Accurate

The following important claims were verified against the source code:

| Claim | Location | Verified Against |
|-------|----------|-----------------|
| `LONG_POLL_TIMEOUT_MS = 4000` (4s) | Ch 6 | `protocol/limits.ts` line 5 |
| `LONG_POLL_CACHE_SECONDS = 20` | Ch 5, 6, 7 | `protocol/limits.ts` line 6 |
| `LONGPOLL_STAGGER_MS = 100` | Ch 6 | `protocol/limits.ts` line 15 |
| `SEGMENT_MAX_MESSAGES_DEFAULT = 1000` | Ch 1 | `protocol/limits.ts` line 17 |
| `SEGMENT_MAX_BYTES_DEFAULT = 4MB` | Ch 1 | `protocol/limits.ts` line 16 |
| `SSE_RECONNECT_MS = 55000` | Ch 8 | `protocol/limits.ts` line 4 |
| Non-TTL cache-control: `public, max-age=60, stale-while-revalidate=300` | Ch 5 | `protocol/expiry.ts` line 66 |
| Expired TTL: `no-store` | Ch 5 | `protocol/expiry.ts` line 67 |
| TTL with time remaining: `max-age=min(60, remaining)` | Ch 5 | `protocol/expiry.ts` lines 68-69 |
| `WsAttachment` type has 5 fields (offset, contentType, useBase64, cursor, streamId) | Ch 1 | `handlers/realtime.ts` lines 33-39 |
| `WsDataMessage` and `WsControlMessage` shapes | Ch 1 | `handlers/realtime.ts` lines 41-54 |
| `HEADER_STREAM_UP_TO_DATE` constant name | Ch 6 | `protocol/headers.ts` line 2 |
| Edge cache store guard: `!cc.includes("no-store") && (!atTail \|\| isLongPoll)` | Ch 5, 6 | `create_worker.ts` line 483 |
| Cache bypass for debug requests (`X-Debug-Coalesce`) | Ch 5, 6 | `create_worker.ts` line 325-326 |
| `ctx.waitUntil(caches.default.put(...))` (fire-and-forget cache store) | Ch 5 | `create_worker.ts` line 484 |
| ETag format: `"streamId:start:end:c"` | Ch 6 | `protocol/etag.ts` line 2 |
| `buildReadResponse` uses `params.meta.closed === 1` for ETag | Ch 6 | `handlers/read.ts` line 67 |
| `handleLongPoll` uses `closedAtTail` for ETag | Ch 6 | `handlers/realtime.ts` line 356, 398 |
| HEAD returns `no-store` | Ch 5 | `handlers/read.ts` line 28 |
| `offset=now` returns `no-store` | Ch 5 | `handlers/read.ts` line 121 |
| SSE returns `Cache-Control: no-cache` | Ch 5 | `handlers/realtime.ts` line 476 |
| Core SQL schema (stream_meta, producers, ops, segments tables) | Ch 1 | `storage/queries.ts` lines 19-72 |
| DO constructor uses `blockConcurrencyWhile` for schema init | Ch 1 | `durable_object.ts` line 37 |
| `StreamDO extends DurableObject` | Ch 1 | `durable_object.ts` line 26 |
| WebSocket accepted via `ctx.acceptWebSocket(server, [streamId])` | Ch 1 | `handlers/realtime.ts` line 772 |
| Sentinel constants marked as removed/historical | Ch 6 | No `SENTINEL_*` or `POLL_*` constants in codebase |
| All file paths in Chapter 1 module tables exist (except `content_strategy.ts`) | Ch 1 | Glob search |
| `ReadPath` class with 100ms coalesce cache | Ch 5, 6 | `stream/read/path.ts` line 17 (`COALESCE_CACHE_MS = 100`) |
| `DoSqliteStorage` class in `storage/queries.ts` | Ch 1 | `storage/queries.ts` line 15 |

---

## Cross-Reference Check

| Cross-Reference | Correct? |
|----------------|----------|
| Ch 0 describes Ch 1 as "Architecture" | Yes |
| Ch 0 describes Ch 9 as "Subscription Design" | Yes |
| Ch 0 describes Ch 10 as "Planned (not implemented)" | Yes |
| Ch 2 references "Chapter 1" for WebSocket bridge architecture | Yes -- Ch 1 describes it |
| Ch 2 references "Chapter 7" for eliminating the VPS proxy | Yes -- Ch 7 discusses this |
| Ch 2 references "Chapter 9" for subscription layer | Yes -- Ch 9 covers subscriptions |
| Ch 4 references "Chapter 6" for cursor issues | Yes -- Ch 6 covers cursor rotation |
| Ch 6 references "Chapter 5" and "Chapter 8" for cache architecture | Consistent |
| Ch 7 references line numbers in source files | Stale (see finding #6) |

---

## Overall Assessment

The documentation is **mostly accurate for the core streaming infrastructure** (Chapters 1-8). The edge caching behavior, protocol constants, SQL schemas for the core package, and architectural descriptions of the WebSocket bridge + Hibernation API are well-documented and match the code.

**Two significant issues stand out**:

1. **Chapter 9 (Subscription Design) describes a system that was never built as designed.** The actual subscription implementation uses a simpler dual-DO model with fan-out via service bindings and an optional Cloudflare Queue, not the heartbeat/offset-tracking system described in the chapter. A developer reading Chapter 9 as a reference for the actual subscription code would be misled. Chapter 9 should either be updated to reflect the actual implementation or clearly labeled as the original design doc (with a note pointing to the actual code).

2. **Long-poll 204 timeout Cache-Control value is documented as `public, max-age=20` but is actually `no-store` in the code.** This appears in both Chapter 5 and Chapter 6. While the docs correctly note that 204s are not cached at the edge (excluded by the `status === 200` check), the stated Cache-Control header value is wrong.

The remaining issues (missing `content_strategy.ts`, phantom `__registry__` stream, missing `public` column, stale line numbers) are minor and unlikely to cause serious confusion.
