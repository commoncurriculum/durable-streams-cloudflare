# Coverage Testing Prompt for LLMs

When working on test coverage for this project, follow this workflow:

## 1. Always Run Fresh Coverage First

```bash
pnpm -C packages/server cov
```

This takes 60-90 seconds. **Never trust existing coverage files** - they can be hours or days old.

## 2. Identify What Needs Testing

```bash
# Show all uncovered lines
pnpm -C packages/server run coverage:lines

# Show only 0% files
pnpm -C packages/server run coverage:lines -- --zero

# Filter by specific area
pnpm -C packages/server run coverage:lines -- estuary
pnpm -C packages/server run coverage:lines -- src/http/v1/streams/append
```

## 3. Write Tests

Follow patterns in CLAUDE.md:
- Unit tests use `worker.app.request()` pattern
- Integration tests use `fetch()` with helpers from `test/implementation/helpers.ts`
- Prefer `@cloudflare/vitest-pool-workers` real bindings over mocks
- Only mock when testing failure paths that can't be triggered naturally

## 4. Verify Coverage Improved

```bash
# Run fresh coverage again
pnpm -C packages/server cov

# Check your specific area improved
pnpm -C packages/server run coverage:lines -- your-area

# Verify no new 0% files
pnpm -C packages/server run coverage:lines -- --zero
```

## Current Status (as of 2026-02-13)

**Overall: 76.11% lines** (1756/2307)

**0% Coverage Files:**
- `src/queue/fanout-consumer.ts` (18 lines)
- `src/util/base64.ts` (13 lines)
- Storage DO index files (re-exports only, 0 actual lines)

## Success Criteria

- Overall coverage stays at or above 76%
- Your area goes from low/0% to 70%+
- No new files added to 0% list
- All tests pass

## Full Documentation

See `COVERAGE.md` for complete documentation.
