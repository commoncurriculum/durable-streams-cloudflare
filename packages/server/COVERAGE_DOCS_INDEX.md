# Coverage Documentation Index

## 🚨 START HERE

If you're an LLM working on testing or coverage, read these files **IN THIS ORDER**:

### 1. **COVERAGE_WARNING.md** (READ FIRST)
**One-page critical warning about stale data**

- Why coverage files can lie to you
- The one rule: Run fresh coverage FIRST
- Real example: 52% vs 0% difference
- Simple decision tree

👉 **Start here every time you check coverage**

### 2. **COVERAGE_VERIFICATION_CHECKLIST.md** (MANDATORY)
**Step-by-step checklist you MUST follow**

- Mandatory steps before reporting coverage
- RED FLAGS for stale data detection
- Wrong vs correct examples
- Copy-paste verification script
- Decision tree for when to report

👉 **Follow this checklist exactly - no exceptions**

### 3. **HOW_TO_RUN_COVERAGE.md** (DETAILED GUIDE)
**Complete step-by-step guide**

- Prerequisites
- Exact commands to run
- Expected output for each step
- Troubleshooting common issues
- Before/after examples

👉 **Reference when you need detailed instructions**

## For Specific Tasks

### Working on Estuary Tests?
Read: **ESTUARY_TESTING_NEW_PROMPT.md**
- Has 🚨 STOP section at top referencing COVERAGE_WARNING.md
- Complete task description with mandatory coverage verification
- Includes all helper code needed

### Need Quick Reference?
Read: **COVERAGE_QUICKSTART.md**
- Fast lookup of commands
- No explanations, just commands

### Understanding the Changes?
Read: **README_COVERAGE_FIXES.md** (this document)
- User-friendly explanation of what changed
- Why these changes were needed
- Success criteria

Read: **COVERAGE_FIXES_SUMMARY.md** (technical)
- Detailed technical documentation
- Root cause analysis
- Pattern documentation

## Agent Instructions

**durable-streams-cloudflare/CLAUDE.md** (Coverage section)
- Integrated into main agent instructions
- References all coverage docs
- Mandatory reading for all coverage work

## The Core Rule

```
NEVER report coverage without running this FIRST:

pnpm -C packages/server cov

This takes 60-90 seconds. Wait for it to complete.
```

## Red Flags (You're Looking at Stale Data)

🚩 Coverage shows 0% but tests exist
🚩 Coverage files modified hours ago
🚩 You didn't run `pnpm -C packages/server cov` just now
🚩 You skipped waiting for coverage generation

**If ANY of these are true → Run fresh coverage first**

## Commands Quick Reference

```bash
# MANDATORY Step 1: Generate fresh coverage
pnpm -C packages/server cov  # Wait 60-90 seconds

# Step 2: ONLY AFTER STEP 1 - Check specific area
pnpm -C packages/server run coverage:lines -- estuary

# Step 3: Check for 0% files
pnpm -C packages/server run coverage:lines -- --zero

# Step 4: Check files below 50%
pnpm -C packages/server run coverage:lines -- --below 50
```

## All Coverage Documentation Files

### Critical Warnings
- `COVERAGE_WARNING.md` - One-page warning (START HERE)
- `COVERAGE_VERIFICATION_CHECKLIST.md` - Mandatory checklist

### Guides
- `HOW_TO_RUN_COVERAGE.md` - Complete guide
- `COVERAGE_QUICKSTART.md` - Quick reference
- `COVERAGE.md` - Original comprehensive guide

### Task-Specific
- `ESTUARY_TESTING_NEW_PROMPT.md` - Estuary testing task with coverage verification

### Documentation About Documentation
- `COVERAGE_DOCS_INDEX.md` - This file
- `README_COVERAGE_FIXES.md` - User-friendly summary of changes
- `COVERAGE_FIXES_SUMMARY.md` - Technical documentation of changes
- `COVERAGE_DOCS_SUMMARY.md` - Summary of earlier coverage work

### Agent Instructions
- `durable-streams-cloudflare/CLAUDE.md` - Main agent instructions (see Coverage section)

## Why So Many Files?

**Because LLMs were lying about coverage by looking at stale data.**

Each file serves a specific purpose:
- **Warnings** → Prevent the mistake
- **Checklists** → Ensure correct process
- **Guides** → Show how to do it right
- **Examples** → Demonstrate wrong vs correct
- **Redundancy** → Make it impossible to miss

## Success Criteria

After reading these docs, you should:

✅ ALWAYS run fresh coverage before reporting numbers
✅ NEVER trust existing coverage files
✅ WAIT for coverage generation to complete (60-90 seconds)
✅ RECOGNIZE red flags for stale data
✅ FOLLOW the mandatory checklist

## The Bottom Line

**Coverage files can be hours or days old. They will lie to you.**

**Run fresh coverage first. Every time. No exceptions.**

```bash
pnpm -C packages/server cov
```

**This is the only way to get accurate coverage data.**
