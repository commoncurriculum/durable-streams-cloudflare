# Coverage Verification Checklist - MANDATORY FOR ALL LLMs

## 🚨 READ THIS FIRST

If you are an LLM working on testing or coverage tasks, you MUST follow this checklist EXACTLY. No exceptions.

## The #1 Rule: NEVER TRUST EXISTING COVERAGE FILES

Coverage files can be **HOURS OR DAYS OLD**. They will give you **COMPLETELY WRONG** information.

**ALWAYS run fresh coverage FIRST. No exceptions. Ever.**

---

## Mandatory Checklist Before Reporting ANY Coverage Numbers

### Step 1: Generate Fresh Coverage (MANDATORY - DO NOT SKIP)

```bash
pnpm -C packages/server cov
```

**This takes 60-90 seconds. Wait for it to complete.**

✅ You MUST see output like:
```
📊 Overall Coverage
   Lines:       XX.XX%
```

❌ If you see this, you have OLD data:
```
$ ls -la coverage-combined/
-rw-r--r--  ... Feb 12 19:24 ...  # HOURS OLD - STALE!
```

### Step 2: ONLY AFTER STEP 1 - Check Specific Area

```bash
# For estuary
pnpm -C packages/server run coverage:lines -- estuary

# For any specific file
pnpm -C packages/server run coverage:lines -- path/to/file.ts

# For 0% files
pnpm -C packages/server run coverage:lines -- --zero
```

### Step 3: Verify Success

- [ ] I ran `pnpm -C packages/server cov` and waited for completion
- [ ] I checked the timestamp - coverage data is FRESH (just generated)
- [ ] The coverage numbers I'm reporting are from THIS run
- [ ] I did NOT look at old coverage files

---

## RED FLAGS: You're Looking at Stale Data If...

🚩 Coverage shows 0% but tests exist in `test/` directory
🚩 Coverage files modified hours or days ago
🚩 You ran coverage commands WITHOUT running `pnpm -C packages/server cov` first
🚩 You're reporting coverage but didn't wait 60-90 seconds for fresh generation

**If ANY of these are true, your coverage data is WRONG. Run fresh coverage.**

---

## Common Mistakes (DON'T DO THESE)

### ❌ WRONG: Checking coverage without fresh run

```bash
# Just checking existing files
$ pnpm run coverage:lines -- estuary
📄 src/http/v1/estuary/publish/index.ts
   Coverage:    0.0%  # THIS IS STALE DATA!
```

### ❌ WRONG: Trusting old files

```bash
$ cat coverage-combined/coverage-summary.json | grep estuary
# Data from 6 hours ago - COMPLETELY WRONG
```

### ❌ WRONG: Skipping the cov command

```bash
$ pnpm test  # Tests pass
$ pnpm run coverage:lines -- estuary  # WRONG - no fresh coverage generated
```

### ✅ CORRECT: Always run fresh coverage first

```bash
# Step 1: MANDATORY
$ pnpm -C packages/server cov  # Wait 60-90 seconds

# Step 2: Now check coverage
$ pnpm run coverage:lines -- estuary
📄 src/http/v1/estuary/publish/index.ts
   Coverage:    52.3%  # FRESH DATA - ACCURATE
```

---

## Verification Script (Copy-Paste This)

```bash
#!/bin/bash
# Run this BEFORE reporting any coverage numbers

echo "Step 1: Generating fresh coverage (60-90 seconds)..."
pnpm -C packages/server cov

if [ $? -ne 0 ]; then
  echo "❌ Coverage generation failed. Fix errors first."
  exit 1
fi

echo "Step 2: Checking coverage for your area..."
pnpm -C packages/server run coverage:lines -- estuary

echo "Step 3: Checking for 0% files..."
pnpm -C packages/server run coverage:lines -- --zero

echo "✅ Coverage data is FRESH and accurate"
```

---

## Decision Tree: Should I Report Coverage?

```
Did I run `pnpm -C packages/server cov` in the last 5 minutes?
├─ YES: Are all tests passing?
│  ├─ YES: ✅ Safe to report coverage numbers
│  └─ NO: ❌ Fix failing tests first, then re-run coverage
└─ NO: ❌ STOP - Run `pnpm -C packages/server cov` first
```

---

## What "Fresh" Means

Fresh coverage data means:

- ✅ Generated within the last 5 minutes
- ✅ `pnpm -C packages/server cov` completed successfully
- ✅ You saw the command output showing test results
- ✅ Coverage files timestamp is recent (just now)

NOT fresh:

- ❌ Coverage files from hours ago
- ❌ You just opened the project and looked at existing files
- ❌ You ran tests but NOT the coverage command
- ❌ Coverage generation failed but you're looking at old files

---

## Example: Correct Workflow for Estuary Task

```bash
# Task: Check estuary coverage status

# Step 1: MANDATORY - Generate fresh coverage
$ cd /path/to/durable-streams-cloudflare
$ pnpm -C packages/server cov
# ... wait 60-90 seconds ...
# ✓ Tests pass
# 📊 Overall Coverage: 63.03%

# Step 2: Check estuary specifically
$ pnpm -C packages/server run coverage:lines -- estuary

📄 src/http/v1/estuary/subscribe/index.ts
   Coverage:    52.4%  (22/  42 lines covered)
   
📄 src/http/v1/estuary/subscribe/http.ts
   Coverage:    87.5%  (7/   8 lines covered)

📄 src/http/v1/estuary/get/index.ts
   Coverage:    0.0%   (0/  15 lines covered)

# Step 3: Report findings
# "Estuary subscribe endpoints have 52-87% coverage.
#  Get/delete/publish endpoints have 0% coverage and need tests."
```

---

## Why This Matters

**Real Example from This Project:**

- Old coverage data (Feb 12 19:24): Showed estuary at **0-12.5%** coverage
- Fresh coverage data (just now): Shows estuary at **52-87%** for subscribe
- **Difference**: 52-87% vs 0% - that's COMPLETELY WRONG information!

An LLM looking at stale data would say "estuary has no tests" when it actually has 50%+ coverage for some endpoints.

---

## Final Checklist Before Reporting Coverage

Answer these questions:

1. Did I run `pnpm -C packages/server cov` within the last 5 minutes? **YES / NO**
2. Did I wait for it to complete (60-90 seconds)? **YES / NO**
3. Did all tests pass? **YES / NO**
4. Are the coverage numbers I'm reporting from THIS run? **YES / NO**

**If ANY answer is NO, run fresh coverage first.**

---

## TL;DR for LLMs

1. **ALWAYS run `pnpm -C packages/server cov` FIRST**
2. **NEVER trust existing coverage files**
3. **WAIT for the command to complete (60-90 seconds)**
4. **THEN check specific areas with `coverage:lines`**
5. **If coverage shows 0% but tests exist = STALE DATA**

**Every single time you check coverage, run fresh coverage first. No exceptions.**
