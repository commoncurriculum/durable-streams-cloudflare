# Coverage Guide

**Current Overall Coverage: 80.14% lines** (as of 2026-02-13)

- **Lines**: 80.14% (1849/2307)
- **Statements**: 78.35% (1940/2476)
- **Functions**: 83.42% (312/374)
- **Branches**: 69.89% (952/1362)

## Quick Commands

```bash
# 1. ALWAYS run fresh coverage first (takes 60-90 seconds)
pnpm -C packages/server cov

# 2. Show all uncovered lines (machine-readable)
pnpm -C packages/server run coverage:lines

# 3. Filter by area/file
pnpm -C packages/server run coverage:lines -- estuary
pnpm -C packages/server run coverage:lines -- src/http/v1/streams/append

# 4. Show only 0% coverage files
pnpm -C packages/server run coverage:lines -- --zero

# 5. Show files below a threshold
pnpm -C packages/server run coverage:lines -- --below 50
```

## ⚠️ CRITICAL: Coverage Data Can Be Stale

**Coverage files can be HOURS or DAYS OLD.** Always run `pnpm -C packages/server cov` first before checking coverage numbers. Old coverage data will give you completely wrong information.

### Never Trust Existing Files

DO NOT look at these files without running fresh coverage first:
- `coverage-combined/coverage-summary.json` - Can be stale
- `.nyc_output_merged/out.json` - Can be stale
- Any `coverage*/` directory contents - Can be stale

### Correct Workflow

```bash
# ❌ WRONG - Looking at old data
$ pnpm run coverage:lines -- estuary
# Shows 0% but this might be from hours ago!

# ✅ CORRECT - Always run fresh coverage first
$ pnpm -C packages/server cov  # Takes 60-90 seconds
$ pnpm run coverage:lines -- estuary
# Shows actual current coverage
```

## Output Format

The `coverage:lines` script shows uncovered lines in an easy-to-parse format:

```
📄 src/http/v1/estuary/publish/index.ts
   Coverage:    0.0%  (0/  62 lines covered)
   Uncovered:   62 line(s)
   Lines:     11-16, 19-23, 28-39, 48-49, 51, 61-64, ...
```

## Areas Needing Coverage (0% files)

**Storage DO index files** (re-exports only, 0 actual lines):
- `src/storage/stream-do/index.ts`
- `src/storage/estuary-do/index.ts`
- `src/storage/stream-subscribers-do/index.ts`

## Priority Areas for Testing

- `src/http/v1/estuary/index.ts` — 29.0%
- `src/http/worker.ts` — 33.3%
- `src/http/v1/streams/realtime/handlers.ts` — 46.9%
- `src/http/v1/streams/append/index.ts` — 55.1%
- `src/storage/estuary-do/queries.ts` — 58.3%

## How Coverage Works

### Coverage Collection

The `pnpm -C packages/server cov` command runs:

1. **Unit tests** (`vitest.unit.config.ts`) with Istanbul coverage
2. **Integration tests** (`vitest.config.ts`) with Istanbul coverage
3. **Merges** both coverage reports into `coverage-combined/`

### Coverage Files

- `.nyc_output_merged/out.json` - Full Istanbul coverage data (JSON)
- `coverage-combined/coverage-summary.json` - Per-file summary stats
- `coverage-combined/lcov.info` - LCOV format (for tools like VSCode extensions)

### Viewing Coverage

**Machine-readable** (for agents/scripts):
```bash
pnpm run coverage:lines
pnpm run coverage:lines -- --zero
pnpm run coverage:lines -- --below 70
```

**Human-readable HTML** (for developers):
```bash
open coverage-combined/index.html
```

## Adding Tests for Uncovered Code

### 1. Identify uncovered lines

```bash
pnpm -C packages/server cov
pnpm run coverage:lines -- src/path/to/file.ts
```

### 2. Write tests

See test patterns in `CLAUDE.md` - prefer integration tests via `@cloudflare/vitest-pool-workers` over mocks.

### 3. Verify coverage improved

```bash
# Run fresh coverage
pnpm -C packages/server cov

# Check your specific file
pnpm run coverage:lines -- src/path/to/file.ts

# Verify no new 0% files
pnpm run coverage:lines -- --zero
```

### What Success Looks Like

- Overall coverage: 80%+ (should increase if you added tests)
- Your file goes from low/0% to 70%+
- No new files in the 0% list
- All your test files pass

## Common Issues

### "Coverage shows 0% but I wrote tests!"

You're looking at stale coverage data. Run `pnpm -C packages/server cov` first.

### "I want to see what lines aren't covered"

```bash
# Run fresh coverage
pnpm -C packages/server cov

# Show uncovered lines for a specific file
pnpm run coverage:lines -- src/http/v1/estuary/publish/index.ts
```

### "How do I check coverage in CI?"

CI runs the full coverage via `pnpm -r run test`, which includes coverage collection for the server package. The coverage report is generated but not currently enforced as a gate.

## Scripts Reference

All scripts are in `packages/server/package.json`:

- `cov` - Run all tests with coverage + merge reports (60-90 seconds)
- `test:coverage` - Unit tests with coverage only
- `test:implementation-coverage` - Integration tests with coverage only
- `coverage:lines` - Show uncovered lines (requires existing coverage data)
- `test` - Integration tests (no coverage)
- `test:unit` - Unit tests (no coverage)

## For LLMs/Agents

### Mandatory Pre-Check

**BEFORE** reporting ANY coverage numbers:
1. Run `pnpm -C packages/server cov`
2. Wait for it to complete (60-90 seconds)
3. THEN check coverage files

### Parseable Output

Use `coverage:lines` for machine-readable output:

```bash
pnpm run coverage:lines -- --zero
pnpm run coverage:lines -- estuary
pnpm run coverage:lines -- --below 50
```

Output format is consistent and easy to parse:
- File path after `📄`
- Coverage percentage on "Coverage:" line
- Uncovered line numbers on "Lines:" line

### When Reporting Coverage

Always include:
1. Confirmation that you ran fresh coverage first
2. The specific area/file coverage percentage
3. Number of uncovered lines
4. Timestamp or "as of [date]"

Example:
```
After running fresh coverage (pnpm cov):
- src/http/v1/estuary/publish/index.ts: 0% (62 uncovered lines)
- Overall: 80.14% lines
```

## Further Reading

- **Test patterns**: See `CLAUDE.md` section "Testing"
- **CI checks**: See `CLAUDE.md` section "Pre-Push Checklist"
- **Vitest config**: See `vitest.unit.config.ts` and `vitest.config.ts`
