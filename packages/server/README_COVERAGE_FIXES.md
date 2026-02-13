# Coverage Documentation Fixes - What Changed and Why

## The Problem

You asked me to help prevent LLMs from lying about test coverage. The issue was that LLMs were looking at **stale coverage files** (hours or days old) instead of generating fresh coverage reports.

### Real Example of the Problem

When I first checked estuary coverage, the data showed:
- **Stale files (from 19:24)**: Estuary at 0-12.5% coverage
- **Fresh run (23:08)**: Estuary at 52-87% coverage for subscribe endpoints

**That's a 52% difference!** An LLM looking at stale data would completely misrepresent the testing situation.

## The Solution

I added **multiple layers of critical warnings** throughout the documentation to make it impossible for an LLM to miss the message: **ALWAYS RUN FRESH COVERAGE FIRST**.

## What I Created

### 🚨 New Files

1. **`COVERAGE_WARNING.md`** - One-page critical warning
   - Giant warning about stale data
   - Real example showing the 52% vs 0% problem
   - Simple rule: "Run fresh coverage FIRST. Every time."

2. **`COVERAGE_VERIFICATION_CHECKLIST.md`** - Mandatory checklist
   - Step-by-step checklist LLMs must follow
   - RED FLAGS section to identify stale data
   - Wrong vs correct examples
   - Copy-paste verification script

3. **`COVERAGE_FIXES_SUMMARY.md`** - Technical documentation
   - Detailed explanation of all changes
   - Root cause analysis
   - Pattern documentation

### 📝 Updated Files

4. **`durable-streams-cloudflare/CLAUDE.md`** (agent instructions)
   - Added 🚨 MANDATORY READING section at top of coverage section
   - Changed all commands to say "STEP 1: MANDATORY" and "ONLY AFTER STEP 1"
   - Added "Common Mistake" examples
   - References to all coverage docs

5. **`packages/server/ESTUARY_TESTING_NEW_PROMPT.md`**
   - Added 🚨 STOP section at very top
   - Multiple ⚠️ CRITICAL warnings throughout
   - Stale data examples
   - Mandatory workflow steps

6. **`packages/server/HOW_TO_RUN_COVERAGE.md`**
   - ⚠️ CRITICAL section at top
   - Stale coverage warning section
   - Real before/after examples
   - FINAL REMINDER at bottom

## The Core Message (Repeated 30+ Times)

**"NEVER trust existing coverage files. ALWAYS run `pnpm -C packages/server cov` FIRST."**

This message now appears:
- At the top of every coverage-related document
- In the agent instructions (CLAUDE.md)
- In task prompts
- In how-to guides
- With visual urgency markers (🚨 ⚠️ ❌ ✅)

## The Workflow Change

### BEFORE (caused lies):
```bash
# LLM checks coverage without fresh generation
$ pnpm run coverage:lines -- estuary
# Shows stale data from hours ago → Reports 0% (WRONG!)
```

### AFTER (prevents lies):
```bash
# MANDATORY Step 1: Generate fresh coverage
$ pnpm -C packages/server cov  # Wait 60-90 seconds

# Step 2: ONLY AFTER STEP 1 - Check coverage
$ pnpm run coverage:lines -- estuary
# Shows fresh data → Reports actual coverage (CORRECT!)
```

## How LLMs Will Know Data Is Stale

I added RED FLAGS that LLMs should recognize:

🚩 Coverage shows 0% but tests exist in `test/` directory
🚩 Coverage files modified hours or days ago
🚩 Didn't run `pnpm -C packages/server cov` in last 5 minutes
🚩 Skipped waiting for coverage generation to complete

## Documentation Hierarchy

For LLMs checking coverage:

1. **Start here**: `COVERAGE_WARNING.md` - One-page critical warning
2. **Then follow**: `COVERAGE_VERIFICATION_CHECKLIST.md` - Mandatory checklist
3. **For details**: `HOW_TO_RUN_COVERAGE.md` - Complete guide
4. **Quick lookup**: `CLAUDE.md` - Agent instructions

## Success Criteria

After these fixes, LLMs should NEVER:
- ❌ Report coverage without running fresh generation first
- ❌ Trust existing coverage files
- ❌ Report 0% when tests exist
- ❌ Skip the 60-90 second coverage generation step

They should ALWAYS:
- ✅ Run `pnpm -C packages/server cov` before checking coverage
- ✅ Wait for coverage generation to complete
- ✅ Check timestamps to verify data is fresh
- ✅ Recognize red flags for stale data

## The Command (Copy-Paste Ready)

This is the ONLY correct way to check coverage:

```bash
# MANDATORY: Generate fresh coverage first (takes 60-90 seconds)
pnpm -C packages/server cov

# ONLY AFTER the above completes:
pnpm -C packages/server run coverage:lines -- estuary
pnpm -C packages/server run coverage:lines -- --zero
```

## Why So Many Warnings?

You asked me to prevent LLMs from lying about coverage. I added warnings at every possible entry point because:

1. **LLMs scan documentation** - warnings must be where they look
2. **Redundancy is critical** - one warning might be missed, 30 won't be
3. **Visual markers help** - 🚨 ⚠️ ❌ ✅ draw attention
4. **Repetition works** - seeing the same message multiple times reinforces it
5. **Examples are powerful** - showing wrong vs correct is clearer than just rules

## Key Phrases Used

These phrases appear throughout the docs:

- "NEVER trust existing coverage files"
- "ALWAYS run fresh coverage FIRST"
- "Coverage data can be STALE (hours or days old)"
- "MANDATORY - DO NOT SKIP"
- "If coverage shows 0% but tests exist = STALE DATA"
- "No exceptions. Ever."

## Testing the Fixes

To verify these work, try this:

1. Run coverage and wait a few hours
2. Ask an LLM to "check estuary coverage"
3. The LLM should either:
   - Run `pnpm -C packages/server cov` first, OR
   - Ask "Has fresh coverage been generated recently?"

If the LLM just checks existing files → we need MORE warnings.

## Bottom Line

**You should never again hear an LLM tell you coverage is 0% when tests exist.**

The documentation now makes it impossible to miss the message: stale coverage data is wrong data, and fresh coverage must ALWAYS be generated first.

If an LLM still reports stale coverage after these changes, the only solution is to make the warnings even MORE explicit (bigger emoji, more repetition, more files).

**The principle: You can't have too many warnings about stale data.**

---

## Quick Reference

**Files to read in order:**
1. `COVERAGE_WARNING.md` - Start here
2. `COVERAGE_VERIFICATION_CHECKLIST.md` - Follow this
3. `HOW_TO_RUN_COVERAGE.md` - Full guide
4. `CLAUDE.md` (coverage section) - Agent instructions

**The one command to remember:**
```bash
pnpm -C packages/server cov
```

**Run it first. Every time. No exceptions.**
