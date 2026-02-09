# Fix Plan from Code Review #3 (Validated)

**All findings confirmed at stated severity.**
**Additional findings from validation:**
- JWT claims divergence: subscription lacks stream_id support
- CORS fallback behavior differs between packages, undocumented

---

## SECURITY

### SEC-1: CORS — Remove wildcard default, require explicit configuration
- **What:** Unconfigured deployments allow all origins (wildcard).
- **Where:**
  - `packages/core/src/http/create_worker.ts:42-48`
  - `packages/subscription/src/http/create_worker.ts:26-49`
- **How:** Change `if (!corsOrigins) return "*"` to throw or reject. Require explicit CORS_ORIGINS.
- **Effort:** S
- **Priority:** P0

### SEC-2: Producer ID — Add pattern validation
- **What:** Producer ID only checked for empty, accepts any string.
- **Where:** `packages/core/src/stream/producer.ts:45-47`
- **How:** Add `PRODUCER_ID_PATTERN` regex (e.g., `/^[a-zA-Z0-9_\-:.]+$/`). Validate before storage.
- **Effort:** S
- **Priority:** P0

### SEC-3: Supply chain — Replace GitHub PR preview dependency
- **What:** `@cloudflare/vitest-pool-workers` points to GitHub PR build.
- **Where:** `packages/subscription/package.json:41`
- **How:** Replace with official npm release when available.
- **Effort:** S
- **Priority:** P0

---

## AUTH & IDENTITY

### AUTH-1: Extract shared JWT & auth logic into monorepo package
- **What:** ~65 lines of identical JWT code in core and subscription. Security fix could be missed.
- **Where:**
  - `packages/core/src/http/auth.ts:47-135`
  - `packages/subscription/src/http/auth.ts:116-180`
- **How:** Create `packages/auth/` with shared `base64UrlDecode`, `lookupProjectConfig`, `verifyProjectJwt`, types. Update both packages to import from shared.
- **Effort:** M
- **Priority:** P1

### AUTH-2: Document KV ACL requirement for REGISTRY
- **What:** REGISTRY KV namespace must have private ACL; not enforced or documented.
- **Where:** Both auth files, README, deployment guide
- **How:** Add JSDoc comments and README section.
- **Effort:** S
- **Priority:** P1

### AUTH-3: Add stream_id claim to subscription JWT type
- **What:** Core supports optional `stream_id` claim; subscription doesn't.
- **Where:** `packages/subscription/src/http/auth.ts:127-131`
- **How:** Add `stream_id?: string` to ProjectJwtClaims type. Update verify function.
- **Effort:** S
- **Priority:** P1

### AUTH-4: Document CORS fallback behavior differences
- **What:** Core and subscription handle CORS fallback differently.
- **Where:** Both create_worker.ts files
- **How:** Create `docs/cors-configuration.md` documenting both behaviors.
- **Effort:** S
- **Priority:** P1

---

## CODE QUALITY

### CQ-1: Standardize error response format to JSON
- **What:** Core returns text/plain errors, subscription returns JSON.
- **Where:** `packages/core/src/protocol/errors.ts:4-6`
- **How:** Update `errorResponse()` to return `Response.json({ error: message }, { status })`.
- **Effort:** M
- **Priority:** P1

### CQ-2: Add comments to fire-and-forget `.catch(() => {})` patterns
- **What:** Multiple silent catches indistinguishable from bugs.
- **Where:** `packages/core/src/http/create_worker.ts:142,147,170,178,182`, `packages/core/src/http/handlers/write.ts:252`
- **How:** Add `// Fire-and-forget: [reason]` comment above each.
- **Effort:** S
- **Priority:** P1

### CQ-3: Add structured logging with context
- **What:** Core has zero logging; subscription logs without context.
- **Where:** `packages/core/src/http/router.ts:71-80` (catch-all), subscription cleanup/queue files
- **How:** Define structured logging helper. Include timestamp, level, request ID, context.
- **Effort:** M
- **Priority:** P1

### CQ-4: Pin devDependency versions
- **What:** `oxfmt`, `oxlint`, `@cloudflare/workers-types`, etc. use `"latest"`.
- **Where:** All package.json files
- **How:** Replace with pinned caret ranges.
- **Effort:** S
- **Priority:** P2

### CQ-5: Standardize tsconfig across packages
- **What:** moduleResolution case, noEmit, workers-types version differ.
- **Where:** All tsconfig.json files
- **How:** Create root `tsconfig.base.json`. All packages extend it.
- **Effort:** M
- **Priority:** P2

### CQ-6: Extract shared test helpers
- **What:** `delay()`, `uniqueStreamId()`, client factories duplicated.
- **Where:** Core and subscription test directories
- **How:** Create `packages/test-helpers/` package.
- **Effort:** M
- **Priority:** P2

### CQ-7: Extract shared admin analytics infrastructure
- **What:** Both admin packages have identical `queryAnalytics()` boilerplate.
- **Where:** Both `admin-*/src/lib/analytics.ts` files
- **How:** Create `packages/admin-shared/src/analytics.ts`.
- **Effort:** M
- **Priority:** P2

### CQ-8: Add test for queue fallback path
- **What:** Inline fanout fallback when queue fails has no test.
- **Where:** `packages/subscription/src/subscriptions/do.ts:182-189`
- **How:** Mock queue.send() to reject, verify subscribers receive messages via inline.
- **Effort:** M
- **Priority:** P2

### CQ-9: Document or remove `extractBearerToken` public export
- **What:** Exported but not used internally.
- **Where:** `packages/core/src/http/auth.ts:40-44`, `worker.ts:155`
- **How:** Document as public API or remove from exports.
- **Effort:** S
- **Priority:** P2

### CQ-10: Generic catch-all in router — add logging
- **What:** Router catch-all returns 500 without logging.
- **Where:** `packages/core/src/http/router.ts:71-80`
- **How:** Add `console.error()` and optional metrics datapoint.
- **Effort:** S
- **Priority:** P2
