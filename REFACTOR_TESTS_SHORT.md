# Quick Test Refactor Prompt

**Paste this into a new LLM to refactor unit tests to use Hono's app.request() pattern.**

---

## Task

Refactor unit tests in `packages/server/test/unit/` from verbose `worker.fetch!()` to clean `app.request()`.

## Files to Update

```bash
cd packages/server
grep -l "worker.fetch!" test/unit/**/*.test.ts
```

**Known files:**
- `test/unit/http/middleware/authentication.test.ts`
- `test/unit/http/middleware/cors.test.ts`
- `test/unit/http/v1/config/index.test.ts`

## Pattern

### Before (verbose)
```typescript
import type { BaseEnv } from "../../../../src/http/worker";

function makeEnv(): BaseEnv {
  return { ...env } as unknown as BaseEnv;
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

const response = await worker.fetch!(
  new Request("http://localhost/v1/stream/test", {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
  }) as unknown as Request<unknown, IncomingRequestCfProperties>,
  makeEnv(),
  makeCtx(),
);
```

### After (clean)
```typescript
const response = await worker.app.request(
  "/v1/stream/test",
  {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
  },
  env,
);
```

## Changes

1. **Delete helper functions**: `makeEnv()`, `makeCtx()`
2. **Remove import**: `import type { BaseEnv }`
3. **Keep import**: `import { env } from "cloudflare:test"`
4. **Replace calls**:
   - Extract path: `http://localhost/v1/stream/test` → `/v1/stream/test`
   - Use: `worker.app.request(path, init, env)`
   - Move method/headers/body to init object

## Examples

### GET
```typescript
// Before
await worker.fetch!(new Request("http://localhost/v1/config/project"), makeEnv(), makeCtx())

// After
await worker.app.request("/v1/config/project", {}, env)
```

### POST with Body
```typescript
// Before
await worker.fetch!(
  new Request("http://localhost/v1/stream/test", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "data",
  }) as unknown as Request<unknown, IncomingRequestCfProperties>,
  makeEnv(),
  makeCtx(),
)

// After
await worker.app.request(
  "/v1/stream/test",
  {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "data",
  },
  env,
)
```

## Process

For each file:
1. Delete `makeEnv()` and `makeCtx()` functions
2. Remove `import type { BaseEnv }`
3. Find: `worker.fetch!(`
4. Extract path from URL
5. Replace with `worker.app.request(path, init, env)`
6. Test: `pnpm run test:unit -- path/to/file.test.ts`

## Verify

```bash
# After each file
pnpm run test:unit -- test/unit/path/to/file.test.ts

# After all files
pnpm run test:unit
pnpm cov

# Should find nothing
grep -r "worker.fetch!" test/unit/
```

## Success

- [ ] All unit tests pass
- [ ] Coverage unchanged
- [ ] No `worker.fetch!()` in test/unit/
- [ ] No `makeEnv()` or `makeCtx()` helpers

For full details, see `REFACTOR_TESTS_PROMPT.md`.
