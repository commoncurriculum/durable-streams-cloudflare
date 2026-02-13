# Coverage Documentation Fixes - Summary

## Problem Statement

LLMs were reporting incorrect coverage information because they were looking at **STALE coverage data** (hours or days old) instead of generating fresh coverage reports.

**Real Example**:
- Stale data (Feb 12 19:24): Showed estuary at 0-12.5% coverage
- Fresh data (Feb 13 23:08): Showed estuary at 52-87% coverage for subscribe endpoints
- **Difference**: 52-87% vs 0% - completely wrong information!

This led to LLMs claiming "estuary has no tests" when it actually had substantial coverage.

## Root Cause

1. Coverage files persist on disk after running `pnpm -C packages/server cov`
2. LLMs would check coverage by looking at these existing files
3. Files could be hours or days old from previous runs
4. No warnings existed about stale data
5. Documentation didn't emphasize "run fresh coverage FIRST"

## Solution: Multi-Layer Warnings

Added CRITICAL warnings and mandatory checklists at multiple levels to prevent LLMs from ever trusting stale data.

## Files Created

### 1. `packages/server/COVERAGE_WARNING.md`
**Purpose**: One-page critical warning - the FIRST thing LLMs should see
**Key content**:
- Giant warning about stale data
- Real example showing 52% vs 0% difference
- Simple decision tree
- Single rule: "Run fresh coverage FIRST"

### 2. `packages/server/COVERAGE_VERIFICATION_CHECKLIST.md`
**Purpose**: Mandatory step-by-step checklist for all LLMs
**Key content**:
- Detailed checklist with ✅/❌ examples
- RED FLAGS section for stale data detection
- Common mistakes with wrong/correct examples
- Decision tree for when to report coverage
- Copy-paste verification script

### 3. Updated: `packages/server/HOW_TO_RUN_COVERAGE.md`
**Changes**:
- Added ⚠️ CRITICAL section at top
- "ALWAYS RUN FRESH COVERAGE" repeated multiple times
- Added "Stale Coverage Data" warning section
- Real example of stale vs fresh data problem
- "FINAL REMINDER" section at bottom
- Every step now emphasizes "ONLY AFTER running fresh coverage"

## Files Updated

### 4. Updated: `durable-streams-cloudflare/CLAUDE.md`
**Changes in Coverage section**:
- Added 🚨 MANDATORY READING reference to COVERAGE_VERIFICATION_CHECKLIST.md
- Added ⚠️ CRITICAL WARNING about stale data before command list
- Changed all commands to say "STEP 1: MANDATORY" and "ONLY AFTER STEP 1"
- Added "Common Mistake" section showing wrong vs correct approach
- Added "If coverage shows 0% but tests exist" troubleshooting
- Added references to all coverage docs

### 5. Updated: `packages/server/ESTUARY_TESTING_NEW_PROMPT.md`
**Changes**:
- Added ⚠️ CRITICAL section at very top
- Changed all instructions to emphasize "MANDATORY fresh coverage first"
- Added "Stale Coverage Data" warnings throughout
- Added "Common Mistake" section with wrong/correct examples
- Changed workflow to explicitly label mandatory steps
- Added 🚨 CRITICAL REMINDERS section at bottom
- Every verification step now says "ONLY AFTER running fresh coverage"

## Key Patterns Used

### 1. Visual Urgency Markers
- 🚨 for critical warnings
- ⚠️ for important notes
- ❌ for wrong examples
- ✅ for correct examples
- 🚩 for red flags

### 2. Repetition
The phrase "run fresh coverage first" or variations appears **30+ times** across the documentation to hammer the point home.

### 3. Contrast Examples
Every document shows:
- ❌ WRONG: What not to do (checking old files)
- ✅ CORRECT: What to do (run fresh coverage)

### 4. Mandatory Language
- "MUST" instead of "should"
- "MANDATORY" instead of "recommended"
- "DO NOT SKIP" instead of "please run"
- "No exceptions" instead of "when possible"

### 5. Multi-Layer Defense
Warnings appear at:
1. Top of task prompts (ESTUARY_TESTING_NEW_PROMPT.md)
2. Agent instructions (CLAUDE.md)
3. Dedicated warning page (COVERAGE_WARNING.md)
4. Detailed checklist (COVERAGE_VERIFICATION_CHECKLIST.md)
5. How-to guide (HOW_TO_RUN_COVERAGE.md)

## What Changed in Workflow

### BEFORE (caused lies):
```bash
# LLM checks coverage
$ pnpm run coverage:lines -- estuary
# Gets stale data from hours ago
# Reports 0% coverage (WRONG!)
```

### AFTER (prevents lies):
```bash
# Step 1: MANDATORY - Generate fresh coverage
$ pnpm -C packages/server cov  # Wait 60-90 seconds

# Step 2: ONLY AFTER STEP 1 - Check coverage
$ pnpm run coverage:lines -- estuary
# Gets fresh data from seconds ago
# Reports actual coverage (CORRECT!)
```

## Red Flags for Detecting Stale Data

LLMs should now recognize these signs:

1. 🚩 Coverage shows 0% but tests exist in `test/` directory
2. 🚩 Coverage files modified hours or days ago
3. 🚩 Didn't run `pnpm -C packages/server cov` in last 5 minutes
4. 🚩 Skipped waiting for coverage generation (60-90 seconds)

## Success Criteria

After these fixes, LLMs should:
- ✅ Always run fresh coverage before reporting numbers
- ✅ Recognize when data is stale
- ✅ Never report 0% coverage when tests exist
- ✅ Understand coverage files can be hours/days old
- ✅ Follow the mandatory checklist
- ✅ Wait for coverage generation to complete

## Testing the Fixes

To verify these fixes work:

1. Run coverage and wait a few hours
2. Ask LLM to check coverage
3. LLM should either:
   - Run `pnpm -C packages/server cov` first, OR
   - Ask if fresh coverage has been run recently

If LLM just checks existing files → fixes failed, need more warnings.

## Documentation Hierarchy

For LLMs working on coverage:

1. **First read**: `COVERAGE_WARNING.md` - One-page critical warning
2. **Then follow**: `COVERAGE_VERIFICATION_CHECKLIST.md` - Mandatory checklist
3. **For details**: `HOW_TO_RUN_COVERAGE.md` - Step-by-step guide
4. **Quick lookup**: Agent instructions in `CLAUDE.md`

## Key Quotes (for emphasis)

From the updated docs:

> "NEVER trust existing coverage files. Coverage data can be STALE (hours or days old). You MUST run `pnpm -C packages/server cov` FIRST before checking any coverage numbers."

> "Coverage files can be HOURS or DAYS OLD. They will give you COMPLETELY WRONG information."

> "If coverage shows 0% but tests exist, you are looking at STALE data. Run fresh coverage first."

> "Every single time you check coverage, run fresh coverage first. No exceptions."

## Commands Summary

**The ONLY correct way to check coverage:**

```bash
# MANDATORY Step 1: Generate fresh coverage (60-90 seconds)
pnpm -C packages/server cov

# Step 2: Check specific area
pnpm -C packages/server run coverage:lines -- estuary

# Step 3: Check for 0% files
pnpm -C packages/server run coverage:lines -- --zero
```

**Never skip Step 1. Ever.**

## Expected Outcome

With these fixes, no LLM should ever again:
- Report 0% coverage when tests exist
- Trust coverage files without running fresh coverage
- Make statements about coverage without generating fresh data
- Skip the mandatory coverage generation step

If an LLM still does any of these → the warnings need to be even MORE explicit.

## Maintenance

If LLMs continue to report stale coverage:
1. Add MORE warnings
2. Make warnings MORE visible (bigger emoji, more caps)
3. Add warnings to MORE files
4. Make language even MORE mandatory
5. Consider adding a pre-commit hook that warns about stale coverage

The principle: **It's impossible to have TOO MANY warnings about stale data.**
