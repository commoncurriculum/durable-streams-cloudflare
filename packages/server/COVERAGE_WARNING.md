# ⚠️ CRITICAL WARNING: COVERAGE DATA CAN BE STALE

## If You're an LLM Checking Coverage - READ THIS FIRST

**STOP. Before you check or report ANY coverage numbers, you MUST:**

```bash
pnpm -C packages/server cov
```

**This takes 60-90 seconds. WAIT FOR IT TO COMPLETE.**

## Why This Matters

Coverage files can be **HOURS or DAYS OLD**. Looking at old files will give you **COMPLETELY WRONG** information about what is tested.

### Real Example from This Project

- **Stale data** (6 hours old): Estuary shows 0% coverage
- **Fresh data** (just generated): Estuary shows 52-87% coverage

**52% vs 0% - that's COMPLETELY DIFFERENT!**

## The Rule (No Exceptions)

```
NEVER report coverage without running fresh coverage FIRST.
NEVER trust existing coverage files.
ALWAYS run: pnpm -C packages/server cov
ALWAYS wait for it to complete (60-90 seconds).
```

## How to Tell If Data Is Stale

🚩 **RED FLAG**: Coverage shows 0% but tests exist
🚩 **RED FLAG**: Coverage files modified hours ago
🚩 **RED FLAG**: You didn't run `pnpm -C packages/server cov` just now

**If ANY of these are true, your data is WRONG.**

## The Only Correct Way

```bash
# Step 1: MANDATORY - Generate fresh coverage
pnpm -C packages/server cov  # Wait 60-90 seconds

# Step 2: ONLY AFTER STEP 1 - Check coverage
pnpm -C packages/server run coverage:lines -- estuary
```

## Decision Tree

```
Did I run `pnpm -C packages/server cov` in the last 5 minutes?
├─ YES: ✅ Safe to report coverage
└─ NO: 🛑 STOP - Run fresh coverage first
```

## Full Documentation

- **Mandatory checklist**: `packages/server/COVERAGE_VERIFICATION_CHECKLIST.md`
- **Step-by-step guide**: `packages/server/HOW_TO_RUN_COVERAGE.md`
- **Agent instructions**: `durable-streams-cloudflare/CLAUDE.md` (Coverage section)

## TL;DR

**Run `pnpm -C packages/server cov` FIRST. Every time. No exceptions.**

Old coverage files will lie to you.
