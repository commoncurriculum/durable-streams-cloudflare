# Coverage Quick Reference

**Current Status**: 62.78% combined coverage | **Goal**: 70%+

---

## 🚀 One Command to Rule Them All

```bash
pnpm cov
```

This runs all tests, merges coverage, and shows you the summary. **Use this before every PR.**

---

## 📊 View Coverage

```bash
# Combined summary (unit + integration) - RECOMMENDED
pnpm run coverage

# Open interactive HTML report (see exact uncovered lines)
open coverage-combined/index.html

# Show uncovered lines in console (parseable by agents/scripts)
pnpm run coverage:lines

# Show uncovered lines for specific area
pnpm run coverage:lines -- estuary

# Show only files with 0% coverage
pnpm run coverage:lines -- --zero

# Show files below 50% coverage
pnpm run coverage:lines -- --below 50

# Unit tests only
pnpm run coverage:unit

# Integration tests only
pnpm run coverage:integration
```

---

## 🎯 Current Priorities

| Area                  | Coverage | Priority    | Action                |
| --------------------- | -------- | ----------- | --------------------- |
| **Estuary endpoints** | 1.8%     | 🔴 CRITICAL | Add integration tests |
| **Queue consumer**    | 0%       | 🟠 MEDIUM   | Add integration test  |
| **Stream append**     | 73%      | 🟡 LOW      | Add edge case tests   |
| **Stream delete**     | 71%      | 🟡 LOW      | Add edge case tests   |
| **SSE/Realtime**      | 47%      | 🟠 MEDIUM   | Add error path tests  |

---

## 🔍 Find What Needs Testing

```bash
# 1. Run coverage
pnpm cov

# 2. Look for "Files with 0% Coverage" section
# 3. Look for "Priority Areas for Testing" section
# 4. View uncovered lines (parseable output)
pnpm run coverage:lines -- --zero

# Or open HTML report for interactive view
open coverage-combined/index.html
```

---

## ✏️ Add Tests

**For API endpoints** (use integration tests):

```bash
# Create test file
touch test/implementation/feature/scenario.test.ts

# Write test
it("does something", async () => {
  const res = await fetch(`${baseUrl}/v1/endpoint`);
  expect(res.status).toBe(200);
});

# Verify coverage improved
pnpm cov
```

**For utilities** (use unit tests):

```bash
# Create test file
touch test/unit/path/to/util.test.ts

# Write test
it("validates input", () => {
  expect(validateSomething("valid")).toBe(true);
});

# Verify coverage improved
pnpm cov
```

---

## 📈 Track Progress

```bash
# Before changes
pnpm cov
# Note: Overall XX.XX%

# After adding tests
pnpm cov
# Should see increased percentage

# Check specific file (console output)
pnpm run coverage:lines -- path/to/file

# Or check in HTML (interactive)
open coverage-combined/index.html
# Navigate to your file, verify green lines
```

---

## 🎯 Success Criteria

- ✅ Run `pnpm cov` before opening PR
- ✅ Overall coverage ≥ 62.78% (don't decrease it!)
- ✅ New code has ≥ 70% coverage
- ✅ No new files with 0% coverage
- ✅ Check HTML report for red lines

---

## 🚫 Common Mistakes

❌ Not running coverage before PR  
❌ Mocking Cloudflare bindings (use real ones)  
❌ Testing dead code (remove it instead)  
❌ Ignoring the HTML report  
❌ Chasing 100% coverage blindly

---

## ✅ Best Practices

✅ Use `pnpm cov` before every PR  
✅ Focus on 0% files first (biggest impact)  
✅ Write integration tests for endpoints  
✅ Use real Cloudflare bindings (`@cloudflare/vitest-pool-workers`)  
✅ Check HTML report for exact uncovered lines  
✅ Test error paths and edge cases

---

## 📚 Coverage Outputs

**Machine-Readable (for agents/scripts)**:

- `pnpm run coverage:lines` - Uncovered lines in console (JSON-like format)
- `.nyc_output_merged/out.json` - Full Istanbul coverage data
- `coverage-combined/coverage-summary.json` - Summary stats

**Human-Readable**:

- `pnpm run coverage` - Console summary with priorities
- `coverage-combined/index.html` - Interactive HTML report

**Documentation**:

- **COVERAGE.md** - Complete guide with examples
- **COVERAGE_ACTION_PLAN.md** - Detailed roadmap
- **COVERAGE_STATUS.md** - Per-file breakdown

---

## 🆘 Troubleshooting

**"Coverage summary not found"**

```bash
# Generate coverage first
pnpm run test:coverage-all
pnpm run coverage
```

**"Coverage looks wrong"**

```bash
# Make sure you ran the full suite
pnpm cov

# Check you're looking at combined, not unit or integration
open coverage-combined/index.html
```

**"Too slow"**

```bash
# Just run unit tests (faster, but incomplete)
pnpm run test:coverage && pnpm run coverage:unit

# Or just integration tests
pnpm run test:implementation-coverage && pnpm run coverage:integration
```

---

**Remember**: The only number that matters is **combined coverage: 62.78%**. We need **70%+**.

Run `pnpm cov` → check priorities → add tests → repeat.
