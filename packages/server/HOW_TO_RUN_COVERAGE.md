# How to Run Test Coverage - Step by Step Guide for LLMs

This guide explains EXACTLY how to run test coverage and verify your changes improved coverage.

## ⚠️ CRITICAL: ALWAYS RUN FRESH COVERAGE

**NEVER trust existing coverage files!** Coverage data can be stale. You MUST run coverage fresh EVERY TIME you check it.

**Coverage files can be hours or days old.** Looking at old coverage reports will give you completely wrong information about what is tested.

## Prerequisites

You are in the project root directory: `/Users/scottamesmessinger/code/commoncurriculum/durable-streams-cloudflare`

## Step 1: Run All Tests with Coverage (MANDATORY FIRST STEP)

```bash
pnpm -C packages/server cov
```

**⚠️ YOU MUST RUN THIS COMMAND FIRST - DO NOT SKIP THIS STEP!**

This command takes 60-90 seconds. Do not skip it. Do not trust old coverage files.

**What this does:**

1. Runs unit tests with coverage collection
2. Runs integration tests with coverage collection
3. Merges both coverage reports into `coverage-combined/`
4. Displays a summary to the console
5. **Overwrites any stale coverage data with fresh results**

**Expected output:**

```
📊 Overall Coverage

   Lines:       63.03%  (1499 / 2378)
   Statements:  61.71%  (1573 / 2549)
   Branches:    59.47%  (832 / 1399)
   Functions:   60.78%  (231 / 380)
```

## Step 2: Check Coverage for Specific Area

**ONLY AFTER Step 1 completes successfully**, check coverage for the area you worked on:

```bash
# Check estuary coverage
pnpm -C packages/server run coverage:lines -- estuary

# Check any specific file
pnpm -C packages/server run coverage:lines -- src/http/v1/estuary/publish/index.ts
```

**Expected output:**

```
📄 src/http/v1/estuary/publish/index.ts
   Coverage:    75.0%  (45/  60 lines covered)
   Uncovered:   15 line(s)
   Lines:     11-16, 48-49, 61-64
```

## Step 3: View Files with 0% Coverage

```bash
pnpm -C packages/server run coverage:lines -- --zero
```

This shows all files that have NO test coverage.

## Step 4: View Files Below 50% Coverage

```bash
pnpm -C packages/server run coverage:lines -- --below 50
```

This shows all files with less than 50% coverage.

## Complete Workflow Example

Here's a complete example workflow after writing tests:

```bash
# 1. Run all tests to make sure they pass
pnpm -C packages/server test

# 2. Run coverage analysis
pnpm -C packages/server cov

# 3. Check your specific area improved
pnpm -C packages/server run coverage:lines -- estuary

# 4. Verify no new 0% coverage files
pnpm -C packages/server run coverage:lines -- --zero
```

## What Success Looks Like

After adding tests for estuary endpoints, you should see:

**Before:**

```
📄 src/http/v1/estuary/publish/index.ts
   Coverage:    0.0%  (0/  62 lines covered)
```

**After:**

```
📄 src/http/v1/estuary/publish/index.ts
   Coverage:    75.0%  (47/  62 lines covered)
```

## ⚠️ WARNING: Stale Coverage Data

**The #1 cause of incorrect coverage reports is looking at OLD data.**

If you see coverage files with timestamps from hours ago:

- `coverage-combined/` directory modified hours ago
- `.nyc_output_merged/out.json` from yesterday

**These files are STALE. You MUST run `pnpm -C packages/server cov` to get fresh data.**

### Example of Stale Data Problem

❌ **WRONG**: Looking at old coverage showing 0%

```bash
$ ls -la coverage-combined/coverage-summary.json
-rw-r--r-- ... Feb 12 19:24 coverage-summary.json  # OLD!

$ pnpm run coverage:lines -- estuary
# Shows 0% coverage for estuary files (STALE DATA!)
```

✅ **CORRECT**: Run fresh coverage first

```bash
$ pnpm -C packages/server cov  # Takes 60-90 seconds
# ... tests run ...

$ pnpm run coverage:lines -- estuary
# Shows actual current coverage (52% for subscribe, etc)
```

## Common Issues

### Issue: Coverage shows 0% but tests exist

**Solution:** You're looking at stale data. Run `pnpm -C packages/server cov` first.

### Issue: "Command not found: pnpm"

**Solution:** You need to install pnpm first:

```bash
npm install -g pnpm
```

### Issue: "No coverage data found"

**Solution:** Run the fresh coverage command:

```bash
pnpm -C packages/server cov  # MUST run this every time
```

### Issue: Tests fail before coverage runs

**Solution:** Fix the failing tests first. Coverage only runs if tests pass.

## Coverage Files Location

After running coverage, files are saved here:

- `packages/server/coverage-combined/` - Combined HTML report
- `packages/server/coverage-combined/coverage-summary.json` - JSON summary
- `packages/server/.nyc_output_merged/out.json` - Raw coverage data

## View HTML Report (Optional)

```bash
# Open in browser
open packages/server/coverage-combined/index.html
```

This gives you a visual report where:

- Green lines = covered by tests
- Red lines = NOT covered by tests
- Yellow = partially covered branches

## Summary Commands (Copy-Paste Ready)

```bash
# Full coverage workflow
pnpm -C packages/server cov

# Check specific area
pnpm -C packages/server run coverage:lines -- estuary

# Files with 0% coverage
pnpm -C packages/server run coverage:lines -- --zero

# Files below 50%
pnpm -C packages/server run coverage:lines -- --below 50
```

## Expected Results for Estuary Testing Task

**BEFORE checking results, you MUST run fresh coverage:**

```bash
pnpm -C packages/server cov  # Takes 60-90 seconds - DO NOT SKIP
```

**THEN** check if you successfully completed the estuary testing task:

1. **Overall coverage increased** from ~63% to ~75%
2. **Estuary files** went from 0-12% to 70%+ coverage
3. **Zero 0% files** in the estuary directory
4. **All tests passing** with no regressions

**Complete verification workflow:**

```bash
# Step 1: Generate fresh coverage (MANDATORY)
pnpm -C packages/server cov

# Step 2: Check estuary-specific results
pnpm -C packages/server run coverage:lines -- estuary
```

## 🚨 FINAL REMINDER

**NEVER report coverage numbers without running `pnpm -C packages/server cov` FIRST.**

Old coverage files will lie to you. Always run fresh coverage before making any statements about what is or isn't tested.
