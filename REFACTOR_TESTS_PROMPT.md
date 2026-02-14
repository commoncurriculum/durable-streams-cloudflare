# Refactor Tests to Use Hono app.request() Pattern

Copy this entire document and paste it into a new LLM session to refactor existing unit tests.

---

## Your Task

Refactor existing unit tests in `packages/server/test/unit/` to use Hono's standard `app.request()` testing pattern instead of the verbose `worker.fetch!()` approach.

## Why Refactor

**Current pattern** (verbose, non-standard):
```typescript
const response = await worker.fetch!(
  new Request("http://localhost/v1/stream/test", {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
  }) as unknown as Request<unknown, IncomingRequestCfProperties>,
  { ...env } as unknown as BaseEnv,
  {} as ExecutionContext,
);
```

**New pattern** (Hono standard, cleaner):
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

**Benefits**:
- ✅ Follows [Hono testing docs](https://hono.dev/docs/guides/testing)
- ✅ Cleaner, more readable
- ✅ Less type casting needed
- ✅ Easier for new contributors to understand

## Files to Refactor

All unit tests that currently use `worker.fetch!()`:

```bash
# Find files using the old pattern
cd packages/server
grep -r "worker.fetch!" test/unit/
```

**Known files**:
1. `test/unit/http/middleware/authentication.test.ts`
2. `test/unit/http/middleware/cors.test.ts`
3. `test/unit/http/v1/config/index.test.ts`
4. Any others found by grep

## Refactoring Pattern

### Before (Old Pattern)
```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createStreamWorker } from "../../../../src/http/worker";
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

describe("Test suite", () => {
  let worker: ReturnType<typeof createStreamWorker>;

  beforeEach(() => {
    worker = createStreamWorker();
  });

  it("tests something", async () => {
    const response = await worker.fetch!(
      new Request("http://localhost/v1/stream/test", {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
      }) as unknown as Request<unknown, IncomingRequestCfProperties>,
      makeEnv(),
      makeCtx(),
    );

    expect(response.status).toBe(201);
  });
});
```

### After (New Pattern)
```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createStreamWorker } from "../../../../src/http/worker";

describe("Test suite", () => {
  let worker: ReturnType<typeof createStreamWorker>;

  beforeEach(() => {
    worker = createStreamWorker();
  });

  it("tests something", async () => {
    const response = await worker.app.request(
      "/v1/stream/test",
      {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
      },
      env,
    );

    expect(response.status).toBe(201);
  });
});
```

## Changes to Make

### 1. Remove Helper Functions
**Delete** these functions (no longer needed):
```typescript
function makeEnv(): BaseEnv { ... }
function makeCtx(): ExecutionContext { ... }
```

### 2. Remove Type Imports
**Remove** these imports (no longer needed):
```typescript
import type { BaseEnv } from "../../../../src/http/worker";
```

### 3. Replace worker.fetch!() Calls

**Find**:
```typescript
await worker.fetch!(
  new Request("http://localhost/v1/stream/test", {
    method: "PUT",
    headers: { ... },
  }) as unknown as Request<unknown, IncomingRequestCfProperties>,
  makeEnv(),
  makeCtx(),
)
```

**Replace with**:
```typescript
await worker.app.request(
  "/v1/stream/test",
  {
    method: "PUT",
    headers: { ... },
  },
  env,
)
```

### 4. Handle Request Bodies

**Old pattern**:
```typescript
new Request("http://localhost/v1/config/project", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ signingSecrets: ["secret"] }),
})
```

**New pattern**:
```typescript
worker.app.request(
  "/v1/config/project",
  {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signingSecrets: ["secret"] }),
  },
  env,
)
```

### 5. Handle Authorization Headers

**Old pattern**:
```typescript
new Request("http://localhost/v1/stream/test", {
  method: "POST",
  headers: {
    "Content-Type": "text/plain",
    Authorization: `Bearer ${token}`,
  },
  body: "test",
})
```

**New pattern**:
```typescript
worker.app.request(
  "/v1/stream/test",
  {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      Authorization: `Bearer ${token}`,
    },
    body: "test",
  },
  env,
)
```

## Step-by-Step Process

For each test file:

1. **Open the file**
   ```bash
   code test/unit/http/middleware/cors.test.ts
   ```

2. **Remove helper functions**
   - Delete `makeEnv()` function
   - Delete `makeCtx()` function

3. **Remove type imports**
   - Remove `import type { BaseEnv }` if present
   - Keep `import { env } from "cloudflare:test"`

4. **Find all worker.fetch!() calls**
   - Use editor search: `worker.fetch!(`
   - Note the URL path, method, headers, and body

5. **Replace each call**
   - Extract path from URL (e.g., `http://localhost/v1/stream/test` → `/v1/stream/test`)
   - Use `worker.app.request(path, init, env)` pattern
   - Move method, headers, body to init object

6. **Test the changes**
   ```bash
   pnpm run test:unit
   ```

7. **Verify coverage**
   ```bash
   pnpm cov
   ```

## Example Refactor

### File: test/unit/http/middleware/cors.test.ts

**Before** (lines 80-95):
```typescript
const response = await worker.fetch!(
  new Request("http://localhost/v1/stream/test-stream", {
    method: "PUT",
    headers: {
      "Content-Type": "text/plain",
      Origin: "https://any-origin.com",
    },
  }) as unknown as Request<unknown, IncomingRequestCfProperties>,
  makeEnv(),
  makeCtx(),
);

expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
```

**After**:
```typescript
const response = await worker.app.request(
  "/v1/stream/test-stream",
  {
    method: "PUT",
    headers: {
      "Content-Type": "text/plain",
      Origin: "https://any-origin.com",
    },
  },
  env,
);

expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
```

## Common Patterns

### GET Request
```typescript
// Before
await worker.fetch!(
  new Request("http://localhost/v1/config/project"),
  makeEnv(),
  makeCtx(),
)

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
    body: "test data",
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
    body: "test data",
  },
  env,
)
```

### OPTIONS (preflight)
```typescript
// Before
await worker.fetch!(
  new Request("http://localhost/v1/stream/test", {
    method: "OPTIONS",
    headers: { Origin: "https://example.com" },
  }) as unknown as Request<unknown, IncomingRequestCfProperties>,
  makeEnv(),
  makeCtx(),
)

// After
await worker.app.request(
  "/v1/stream/test",
  {
    method: "OPTIONS",
    headers: { Origin: "https://example.com" },
  },
  env,
)
```

## Verification

After refactoring each file:

```bash
# 1. Run that specific test file
pnpm run test:unit -- path/to/file.test.ts

# 2. Run all unit tests
pnpm run test:unit

# 3. Check coverage didn't decrease
pnpm cov

# 4. Run full CI checks
pnpm -r run typecheck
pnpm -C packages/server run lint
pnpm -C packages/server run test
```

## What NOT to Change

❌ **Don't change integration tests** - They use `fetch` directly, which is correct
❌ **Don't change test logic** - Only change how the request is made
❌ **Don't change assertions** - Keep all `expect()` statements the same
❌ **Don't change test data** - Keep headers, bodies, URLs the same

## Success Criteria

- [ ] All unit tests pass: `pnpm run test:unit`
- [ ] Coverage unchanged or improved: `pnpm cov`
- [ ] All CI checks pass: `pnpm -r run typecheck && pnpm -C packages/server run test`
- [ ] No more `worker.fetch!()` calls in test/unit/: `grep -r "worker.fetch!" test/unit/` returns nothing
- [ ] No more `makeEnv()` or `makeCtx()` functions in test files
- [ ] Code is cleaner and more readable

## Quick Commands

```bash
# Find all files to refactor
cd packages/server
grep -l "worker.fetch!" test/unit/**/*.test.ts

# After refactoring each file, test it
pnpm run test:unit -- test/unit/path/to/file.test.ts

# Verify all unit tests pass
pnpm run test:unit

# Check coverage
pnpm cov
```

## Estimated Time

- **Per file**: 5-10 minutes
- **Total**: ~30-60 minutes (3-6 files)

## Getting Help

If a test fails after refactoring:

1. Compare the old Request object to new init object
2. Verify path is correct (no `http://localhost` prefix)
3. Check headers are in the init object
4. Check body is in the init object
5. Verify `env` is passed as third parameter

**The behavior should be identical** - only the syntax changes!

---

**Start with `test/unit/http/middleware/cors.test.ts` as it has the most examples!**
