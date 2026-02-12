# Next Steps - Immediate Actions

**Created**: 2025-02-12  
**Status**: 🔴 BLOCKED - Need team input before proceeding

---

## 🛑 STOP - Do Not Write Tests Yet

Before writing any new tests, we must clean up dead code.

**Why**: Don't waste time testing code that will be removed.

---

## Immediate Actions (This Week)

### 1. Review Dead Code Findings

**File**: `DEAD_CODE_ANALYSIS.md`

**Key findings**:
- 15+ unused registry functions (createProject, addSigningKey, etc.)
- Unused constants (isValidStreamId, DEFAULT_ANALYTICS_DATASET)
- Unused exports (getLogger, createMetrics)
- Storage barrel exports that nothing imports

**Decision needed**: Are registry functions planned for admin API or dead code?

### 2. Run Verification Commands

```bash
cd packages/server

# Find all unused exports
npx ts-prune --project tsconfig.src.json | grep -v "(used in module)"

# Check registry function usage
grep -r "createProject\|addSigningKey" src/ --include="*.ts"

# Check what imports from storage/
grep -r "from.*storage" src/ --include="*.ts"
```

### 3. Team Discussion

**Questions for team**:

1. **Registry functions** (`src/storage/registry.ts`):
   - Are `createProject`, `addSigningKey`, etc. planned for admin API?
   - If yes: When will admin API be built? Should we create placeholder?
   - If no: Can we remove these ~200 lines of code?

2. **Storage exports** (`src/storage/index.ts`):
   - Nothing seems to import from this barrel file
   - Can we remove it entirely?
   - Or should we keep for future external use?

3. **Coverage target**:
   - What's acceptable coverage %? (recommendation: integration > unit)
   - Focus on HTTP endpoints or internal functions?

4. **Timeline**:
   - When should Phase 1 (integration tests) be complete?
   - Who will work on this?

---

## After Team Discussion

### Option A: Registry Functions Are Dead Code

```bash
# Remove unused functions
rm -rf src/storage/registry.ts  # Or delete individual functions
# Update src/storage/index.ts to not export registry functions
# Update src/http/worker.ts to not re-export ProjectEntry/StreamEntry
```

### Option B: Registry Functions Are Planned Feature

```bash
# Move to separate module
mkdir -p src/admin
mv src/storage/registry.ts src/admin/registry.ts
# Add comment: "// Planned admin API - not yet implemented"
# Keep exports but document as planned feature
```

---

## Once Code Is Clean

Follow the test strategy in `TEST_STRATEGY.md`:

### Phase 1: Integration Tests (Week 2)

Add missing endpoint tests:

```bash
# Create test files
touch test/implementation/estuary/create_estuary.test.ts
touch test/implementation/estuary/subscribe_unsubscribe.test.ts
touch test/implementation/estuary/publish_fanout.test.ts
touch test/implementation/estuary/touch_keepalive.test.ts
touch test/implementation/estuary/get_info.test.ts
touch test/implementation/queue/fanout_consumer.test.ts
```

**Pattern**: Live workers via `unstable_dev`, no mocks.

### Phase 2: Review Conformance (Week 3)

```bash
# Ensure protocol compliance
pnpm -C packages/server run conformance

# Review test coverage
cat test/conformance/*.test.ts
```

### Phase 3: Unit Tests (Week 4 - Optional)

Only for stable, pure, exported utilities.

---

## Success Criteria

Before considering this "done":

- [ ] Dead code removed or clearly marked as planned feature
- [ ] All public HTTP endpoints have integration tests
- [ ] All conformance tests pass
- [ ] CI checks pass (typecheck, lint, format, tests)
- [ ] Documentation updated (if public API changes)

---

## Commands Reference

### Run all CI checks locally

```bash
cd packages/server

# Typecheck
pnpm run typecheck

# Lint
pnpm run lint

# Format check
pnpm run format:check

# Unit tests
pnpm run test:unit

# Conformance tests
pnpm run conformance

# Integration tests
pnpm run test:implementation
```

### Dead code analysis

```bash
# Find unused exports
npx ts-prune --project tsconfig.src.json

# Find specific function usage
grep -r "functionName" src/ --include="*.ts"

# Count lines of dead code
wc -l src/storage/registry.ts
```

---

## Files to Review

1. **DEAD_CODE_ANALYSIS.md** - Detailed findings
2. **TEST_STRATEGY.md** - High-level approach
3. **COVERAGE_PLAN.md** - Detailed test plan (reference only)
4. **CLAUDE.md** - Project guidelines

---

## What NOT To Do

❌ Don't write unit tests for internal functions  
❌ Don't mock Cloudflare bindings (use real ones)  
❌ Don't test code that will be removed  
❌ Don't start testing before dead code cleanup  
❌ Don't aim for 100% line coverage of everything  

## What TO Do

✅ Focus on public HTTP endpoints  
✅ Use integration tests with live workers  
✅ Use real Cloudflare bindings  
✅ Clean up dead code first  
✅ Test behavior, not implementation  

---

## Timeline Estimate

- **Week 1**: Dead code cleanup + team review
- **Week 2**: Integration test gaps (estuary, queue)
- **Week 3**: Conformance review
- **Week 4**: Unit tests (if needed)

**Total**: ~1 month to comprehensive coverage

---

## Contact

Questions? Ask in team chat or file issue with:
- Link to this document
- Specific question
- Proposed solution (if any)
