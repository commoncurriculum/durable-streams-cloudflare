# Coverage Testing Prompt for LLMs

When working on test coverage for this project, follow this workflow:

## 1. Check Existing Coverage Data

**DO NOT run `pnpm -r run cov` at the start.** It takes 90+ seconds and wastes tokens. Coverage was already collected. Instead, read the existing data:

```bash
# Show all uncovered lines (uses already-collected data)
pnpm -r run coverage:lines

# Show only 0% files
pnpm -r run coverage:lines -- --zero

# Filter by specific area
pnpm -r run coverage:lines -- estuary
pnpm -r run coverage:lines -- src/http/v1/streams/append
```

Only re-run `pnpm -r run cov` **after** you've written new tests and need to verify improvement.

## 2. Write Tests

Follow patterns in CLAUDE.md:
- Unit tests use `worker.app.request()` pattern
- Integration tests use `fetch()` with helpers from `test/implementation/helpers.ts`
- Prefer `@cloudflare/vitest-pool-workers` real bindings over mocks
- Only mock when testing failure paths that can't be triggered naturally

## 3. Verify Coverage Improved

```bash
# Run fresh coverage ONLY after writing tests
pnpm -r run cov

# Check your specific area improved
pnpm -r run coverage:lines -- your-area

# Verify no new 0% files
pnpm -r run coverage:lines -- --zero
```

## Success Criteria

- Overall coverage stays at or above 80%
- Your area goes from low/0% to 70%+
- No new files added to 0% list
- All tests pass

## Full Documentation

See `COVERAGE.md` for complete documentation.
