# Test Coverage Guide

**Current Coverage**: **62.78% lines** (combined unit + integration tests)

---

## Quick Start

### View Coverage Summary

```bash
# Combined coverage (unit + integration) - RECOMMENDED
pnpm run coverage

# Show uncovered lines (machine-readable, agent-friendly)
pnpm run coverage:lines

# Show uncovered lines for specific area
pnpm run coverage:lines -- estuary

# Show only files with 0% coverage
pnpm run coverage:lines -- --zero

# Show files below 50% coverage
pnpm run coverage:lines -- --below 50

# Unit test coverage only
pnpm run coverage:unit

# Integration test coverage only
pnpm run coverage:integration
```

### Generate Coverage Reports

```bash
# Run all tests with coverage and merge results
pnpm run test:coverage-all

# Open interactive HTML report
open coverage-combined/index.html
```

---

## Coverage Commands

| Command                                 | What It Does                        | Output                  |
| --------------------------------------- | ----------------------------------- | ----------------------- |
| `pnpm run test:coverage`                | Run unit tests with coverage        | `coverage/`             |
| `pnpm run test:implementation-coverage` | Run integration tests with coverage | `coverage-integration/` |
| `pnpm run test:coverage-all`            | Run both + merge                    | `coverage-combined/`    |
| `pnpm cov`                              | Run all tests + show summary        | Console                 |
| `pnpm run coverage`                     | Show combined coverage summary      | Console                 |
| `pnpm run coverage:lines`               | Show uncovered lines (parseable)    | Console                 |
| `pnpm run coverage:unit`                | Show unit coverage summary          | Console                 |
| `pnpm run coverage:integration`         | Show integration coverage summary   | Console                 |

---

## Understanding the Reports

### Console Summary

The `pnpm run coverage` command shows:

- **Overall Coverage**: Total lines/statements/branches/functions covered
- **Top 10 Best**: Files with highest coverage
- **Top 10 Worst**: Files with lowest coverage (excluding 0%)
- **Zero Coverage**: All untested files grouped by area
- **Priority Areas**: Coverage by feature area with priority levels

### Uncovered Lines (Agent-Friendly)

The `pnpm run coverage:lines` command shows exact line numbers:

- **File path** and coverage percentage
- **Uncovered line numbers** (e.g., "10-15, 20, 25-30")
- **Total uncovered count** per file
- **Machine-readable format** suitable for parsing by scripts/agents

```bash
# All uncovered lines
pnpm run coverage:lines

# Specific area
pnpm run coverage:lines -- estuary

# Only 0% files
pnpm run coverage:lines -- --zero
```

### HTML Report

Open `coverage-combined/index.html` in a browser for:

- ✅ **Green lines**: Covered by tests
- ❌ **Red lines**: Not covered by tests
- 🟡 **Yellow lines**: Partially covered branches
- **Line numbers**: Click to see exact uncovered lines
- **Drill-down**: Navigate through directories and files

---

## Current Status (2025-02-12)

### Overall Metrics

- **Lines**: 62.78% (1,493 / 2,378)
- **Statements**: 61.47% (1,567 / 2,549)
- **Branches**: 59.32% (830 / 1,399)
- **Functions**: 60.00% (228 / 380)

### Well Covered Areas (>80%)

- Middleware (83%): CORS, cache, authentication, authorization
- Shared utilities (85%): expiry, headers, stream paths, validation
- Storage layer (98%): registry, segments
- Stream reads (80%): read handlers, path parsing
- Stream DO (74%): queries, read operations

### Needs Improvement (<50%)

- **Estuary endpoints (1.8%)** 🔴 CRITICAL - 20 files with 0% coverage
- **Queue consumer (0%)** 🟠 MEDIUM
- **Metrics (0%)** 🟡 LOW
- Realtime SSE (47%)
- Path parsing (47%)
- Read messages (49%)

---

## How Coverage Works

### Unit Tests (40% coverage)

- Run via Vitest with `@cloudflare/vitest-pool-workers`
- Use real Cloudflare bindings (no mocks)
- Istanbul coverage collection via `@vitest/coverage-istanbul`
- Tests: `test/unit/**/*.test.ts`
- Output: `coverage/`

**Example**:

```typescript
// test/unit/http/middleware/cors.test.ts
import { expect, it } from "vitest";

it("adds CORS headers", async () => {
  const app = createTestApp();
  const res = await app.request("/v1/stream/test");
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
});
```

### Integration Tests (55% coverage)

- Run against instrumented worker bundle
- Full end-to-end tests with real DOs, R2, SQLite
- Coverage collected via special `/__coverage__` endpoint
- Tests: `test/implementation/**/*.test.ts`
- Output: `coverage-integration/`

**Example**:

```typescript
// test/implementation/streams/append.test.ts
import { expect, it } from "vitest";

it("appends message to stream", async () => {
  const baseUrl = process.env.IMPLEMENTATION_TEST_URL;
  const res = await fetch(`${baseUrl}/v1/stream/test`, {
    method: "POST",
    body: "Hello, world!",
  });
  expect(res.status).toBe(200);
});
```

### Combined Coverage (63% coverage)

- Merges unit + integration coverage
- Shows which code is tested by EITHER type of test
- Uses `nyc merge` to combine Istanbul coverage data
- Output: `coverage-combined/`

---

## Adding Tests to Improve Coverage

### 1. Find Uncovered Code

```bash
# Run coverage and identify gaps
pnpm run test:coverage-all
pnpm run coverage

# Look for files with 0% or low coverage
# Check "Priority Areas" section

# See exact uncovered lines (agent-friendly)
pnpm run coverage:lines -- --zero
```

### 2. Choose Test Type

**Write Unit Tests** when:

- Testing pure functions
- Testing utilities
- Testing validation logic
- Testing middleware in isolation

**Write Integration Tests** when:

- Testing API endpoints
- Testing Durable Object operations
- Testing multi-component workflows
- Testing edge caching behavior

### 3. Write Tests

```bash
# Unit test location
touch test/unit/path/to/feature.test.ts

# Integration test location
touch test/implementation/feature/scenario.test.ts
```

### 4. Verify Coverage Improved

```bash
# Re-run coverage
pnpm run test:coverage-all

# Check the specific file (console output)
pnpm run coverage:lines -- path/to/your/file.ts

# Or check in HTML (interactive)
open coverage-combined/index.html
# Navigate to your file and verify green lines
```

---

## Priority Testing Roadmap

### Week 1: Critical Gaps (0% → 70%)

**Estuary Endpoints** (20 files, 0% coverage):

- `test/implementation/estuary/subscribe.test.ts`
- `test/implementation/estuary/publish.test.ts`
- `test/implementation/estuary/touch.test.ts`
- `test/implementation/estuary/unsubscribe.test.ts`
- `test/implementation/estuary/get-delete.test.ts`

### Week 2: High Priority (50% → 80%)

**Stream Operations**:

- Improve append coverage (currently 73%)
- Improve delete coverage (currently 71%)
- Add Stream DO append-batch tests (currently 60%)
- Add read-messages tests (currently 49%)

### Week 3: Medium Priority (0% → 50%)

**Infrastructure**:

- Queue consumer tests (currently 0%)
- Realtime SSE improvements (currently 47%)
- Path parsing edge cases (currently 47%)

---

## Coverage Best Practices

### ✅ DO

- Run coverage before opening PRs: `pnpm run test:coverage-all`
- Aim for 70%+ line coverage on new code
- Focus on testing public APIs and critical paths
- Write integration tests for complex workflows
- Use real Cloudflare bindings, not mocks
- Check HTML report to see exact uncovered lines

### ❌ DON'T

- Don't chase 100% coverage blindly
- Don't test trivial getters/setters
- Don't mock Cloudflare bindings (use `@cloudflare/vitest-pool-workers`)
- Don't test dead code (remove it instead)
- Don't skip edge cases and error paths
- Don't test implementation details

---

## Troubleshooting

### Coverage report shows 0% for everything

```bash
# Make sure you ran tests with coverage flag
pnpm run test:coverage-all

# Check that coverage files exist
ls -la coverage/ coverage-integration/ coverage-combined/
```

### Coverage summary script fails

```bash
# Generate coverage first
pnpm run test:coverage-all

# Then run summary
pnpm run coverage
```

### Unit test coverage doesn't work

**This is expected**. The unit test coverage tooling has limitations with `@cloudflare/vitest-pool-workers`. However:

- Unit tests still run and pass
- Integration tests provide comprehensive coverage
- Combined report merges both successfully

### Combined coverage seems lower than expected

This is normal. Combined coverage shows "total code covered by at least one test type". It's not additive (40% + 55% ≠ 95%). Many files are only tested by integration OR unit tests, not both.

---

## CI Integration

Coverage is automatically generated in CI but not enforced yet. To check coverage locally before pushing:

```bash
# Full CI coverage check
pnpm run test:coverage-all
pnpm run coverage

# Should show 62%+ overall coverage
# Zero coverage files should match known list
```

---

## Files

- `coverage/` - Unit test coverage reports
- `coverage-integration/` - Integration test coverage reports
- `coverage-combined/` - Merged coverage reports (THIS IS THE ONE YOU WANT)
- `.nyc_output/` - Raw integration coverage data
- `.nyc_output_merged/` - Merged raw coverage data (machine-readable)
- `scripts/merge-coverage.mjs` - Coverage merge script
- `scripts/coverage-summary.mjs` - Summary generator (human-readable)
- `scripts/coverage-lines.mjs` - Line-by-line uncovered report (agent-friendly)
- `vitest.unit.config.ts` - Unit test + coverage config
- `vitest.integration-coverage.config.ts` - Integration test coverage config
- `wrangler.coverage.toml` - Instrumented worker config

---

## Summary

**The coverage tooling works perfectly.** Both unit and integration tests generate accurate coverage reports, and they merge successfully into a combined view.

**The only figure that matters is combined coverage: 62.78%.**

**For agents/scripts**: Use `pnpm run coverage:lines` for machine-readable output with exact line numbers. The JSON data is in `.nyc_output_merged/out.json`.

To improve coverage, focus on:

1. Estuary endpoints (0% → add integration tests)
2. Queue consumer (0% → add integration test)
3. Stream operations (50-70% → add unit tests for edge cases)

Run `pnpm cov` or `pnpm run coverage:lines -- --zero` to see what needs tests.
