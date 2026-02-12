# Quick Coverage Agent Prompt

**Paste this into a new LLM to work on test coverage.**

---

## Task

Improve test coverage from **62.78% → 70%+** for `packages/server`.

## Quick Start

```bash
cd packages/server
pnpm cov                           # See current status
pnpm run coverage:lines -- --zero  # See 0% files with line numbers
```

## Priority (Highest Impact First)

1. **Estuary endpoints (0%)** - 20 files, ~377 uncovered lines
   - Location: `src/http/v1/estuary/`
   - Need: Integration tests in `test/implementation/estuary/`
2. **Queue consumer (0%)** - 1 file, ~18 uncovered lines
   - Location: `src/queue/fanout-consumer.ts`
   - Need: Integration test in `test/implementation/queue/`

## Context Files

- `AGENTS.md` - Development guidelines (read this first)
- `packages/server/COVERAGE.md` - Complete coverage guide
- `packages/server/COVERAGE_QUICKSTART.md` - Quick reference

## Test Template

**Integration tests** (test/implementation/):

```typescript
import { describe, it, expect } from "vitest";
import { createClient, uniqueStreamId } from "../helpers";

describe("Estuary subscribe", () => {
  it("subscribes session to estuary", async () => {
    const baseUrl = process.env.IMPLEMENTATION_TEST_URL;
    const estuaryId = uniqueStreamId("estuary");

    // Create estuary first
    const createRes = await fetch(`${baseUrl}/v1/estuary/${estuaryId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamId: "test-stream",
        contentType: "application/json",
      }),
    });
    expect(createRes.status).toBe(201);

    // Subscribe
    const res = await fetch(`${baseUrl}/v1/estuary/${estuaryId}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1" }),
    });

    expect(res.status).toBe(200);
  });
});
```

**Unit tests** (test/unit/):

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createStreamWorker } from "../../../src/http/worker";

describe("Feature unit test", () => {
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

**Note**: Integration tests use fetch + helpers from `test/implementation/helpers.ts`. Unit tests use `worker.app.request()`. See `test/implementation/streams/*.test.ts` and `test/unit/http/*.test.ts` for examples.

## Verify

```bash
pnpm run test:implementation  # Run tests
pnpm cov                       # Check coverage improved
```

## Rules

✅ Use real Cloudflare bindings (NO mocks)  
✅ Focus on 0% files first (biggest impact)  
✅ Test error paths, not just happy paths  
❌ Don't mock bindings  
❌ Don't test dead code

## Success

- [ ] Coverage ≥ 70%
- [ ] Estuary endpoints ≥ 70%
- [ ] Queue consumer ≥ 60%
- [ ] All tests pass
- [ ] No new 0% files

**Start with: `pnpm cov` then tackle files shown by `pnpm run coverage:lines -- --zero`**

For full details, see `COVERAGE_AGENT_PROMPT.md`.
