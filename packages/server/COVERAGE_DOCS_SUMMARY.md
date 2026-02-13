# Coverage Documentation Summary

## What Was Done

Updated and created documentation to make it crystal clear how to run test coverage and verify improvements. This addresses the issue where LLMs working on testing tasks weren't understanding how to verify their work increased coverage.

## New Files Created

### 1. `HOW_TO_RUN_COVERAGE.md`
**Purpose**: Step-by-step guide specifically for LLMs on running coverage

**Key sections**:
- Prerequisites and setup
- Step-by-step coverage commands with expected output
- Complete workflow examples
- Troubleshooting common issues
- Coverage file locations
- Expected results for estuary testing task

**Commands documented**:
```bash
pnpm -C packages/server cov                        # Run full coverage
pnpm -C packages/server run coverage:lines         # Show uncovered lines
pnpm -C packages/server run coverage:lines -- estuary  # Filter by area
pnpm -C packages/server run coverage:lines -- --zero   # 0% files only
pnpm -C packages/server run coverage:lines -- --below 50  # Files below threshold
```

### 2. `ESTUARY_TESTING_NEW_PROMPT.md`
**Purpose**: Fresh, clean prompt for estuary testing with explicit coverage verification

**Key improvements**:
- Clear goal statement (1.8% → 70%+)
- Exact files needing tests with line counts
- Helper function code snippets
- Test pattern templates
- **Explicit coverage verification section** with before/after examples
- Full verification workflow with all commands
- Success criteria checklist

**New section**: "How to Verify Coverage Improved" with 4 clear steps and expected output examples.

## Updated Files

### 1. `CLAUDE.md` (Agent Instructions)
**Section updated**: Coverage Workflow (lines ~229-253)

**Changes**:
- Added **"IMPORTANT"** callout
- Converted to 4-step workflow with explanations
- Added "What success looks like" section
- Added reference to `HOW_TO_RUN_COVERAGE.md`

**Before**: Single command with brief comment
```bash
# Before opening PR
pnpm -C packages/server cov
```

**After**: Multi-step workflow with clear expectations
```bash
# Step 1: Run all tests with coverage collection
pnpm -C packages/server cov

# Step 2: Check coverage for your specific area
pnpm -C packages/server run coverage:lines -- estuary

# Step 3: Verify no new 0% coverage files
pnpm -C packages/server run coverage:lines -- --zero

# Step 4: Check files below 50% coverage
pnpm -C packages/server run coverage:lines -- --below 50
```

Plus explicit success criteria.

## Why These Changes Help LLMs

### Problem
LLMs were writing tests but not verifying coverage improved because:
1. Coverage commands weren't obvious from the task prompt
2. No clear "success looks like this" examples
3. Multi-step process not laid out explicitly
4. Expected output not shown

### Solution
1. **Explicit step-by-step workflows** - No ambiguity about what to run
2. **Expected output examples** - LLMs can recognize success
3. **Before/after comparisons** - Clear visual of improvement
4. **Multiple command reference points**:
   - Main agent instructions (CLAUDE.md)
   - Dedicated how-to guide (HOW_TO_RUN_COVERAGE.md)
   - Task prompt (ESTUARY_TESTING_NEW_PROMPT.md)

### Key Patterns Used

1. **Command + Expected Output**: Every command shows what you should see
2. **Step Numbers**: 1, 2, 3, 4 - No confusion about order
3. **Success Criteria**: Explicit checkboxes for "done"
4. **Copy-paste ready**: Code blocks with complete commands
5. **Troubleshooting**: Common issues documented

## Existing Coverage Documentation

These files were already present and working well:
- `COVERAGE.md` - Comprehensive coverage guide
- `COVERAGE_QUICKSTART.md` - Quick reference
- `scripts/coverage-summary.mjs` - Summary generator
- `scripts/coverage-lines.mjs` - Line-by-line reporter

The new docs **complement** these by providing:
- Explicit workflows (vs comprehensive reference)
- LLM-friendly instructions (vs human documentation)
- Task-specific guidance (vs general coverage info)

## Usage

### For Humans
Use `HOW_TO_RUN_COVERAGE.md` as a quick reference for the coverage workflow.

### For LLMs Working on Testing
1. Read `CLAUDE.md` for overall context
2. Get task from `ESTUARY_TESTING_NEW_PROMPT.md` (or similar)
3. Reference `HOW_TO_RUN_COVERAGE.md` when verifying work
4. Follow the 4-step workflow explicitly

### For Creating New Testing Tasks
Copy the "How to Verify Coverage Improved" section from `ESTUARY_TESTING_NEW_PROMPT.md` and adapt it to your specific area.

## Commands Quick Reference

```bash
# Full coverage workflow (run after writing tests)
pnpm -C packages/server cov
pnpm -C packages/server run coverage:lines -- your-area
pnpm -C packages/server run coverage:lines -- --zero
pnpm -C packages/server run coverage:lines -- --below 50

# Open HTML report (optional)
open packages/server/coverage-combined/index.html
```

## Success Metrics

After these documentation updates, LLMs should:
- ✅ Know to run coverage after writing tests
- ✅ Know which commands to run
- ✅ Recognize when coverage improved
- ✅ Understand what "success" looks like
- ✅ Complete testing tasks with verified coverage improvements

## Files Location

All coverage documentation in `packages/server/`:
- `HOW_TO_RUN_COVERAGE.md` - **New** step-by-step guide
- `ESTUARY_TESTING_NEW_PROMPT.md` - **New** task prompt with coverage verification
- `COVERAGE.md` - Existing comprehensive guide
- `COVERAGE_QUICKSTART.md` - Existing quick reference
- `COVERAGE_DOCS_SUMMARY.md` - This file

Agent instructions:
- `durable-streams-cloudflare/CLAUDE.md` - **Updated** with explicit workflow
