# Dead Code Analysis

**Date**: 2025-02-12
**Analyzed using**: ts-prune

## Summary

Found multiple unused exports across the codebase. Before writing tests, we should:

1. **Remove** truly unused code
2. **Keep** planned features but mark them clearly
3. **Refactor** internal APIs to not be exported

## Findings

### 1. Registry Functions (src/storage/registry.ts)

**Status**: ❌ UNUSED - Not called anywhere in src/

```typescript
// These are exported but never used:
- createProject
- addSigningKey
- removeSigningKey
- addCorsOrigin
- removeCorsOrigin
- updatePrivacy
- rotateStreamReaderKey
- putStreamMetadata
- putProjectEntry
- getProjectEntry
- getStreamEntry
- deleteStreamEntry
- listProjects
- listProjectStreams
```

**Recommendation**: 
- Check if these are planned for an admin API
- If yes: Move to separate admin module (not implemented yet)
- If no: Remove entirely
- These functions manipulate KV storage directly and look like CRUD operations for a management API

**Action**: Ask team - are these planned features or can we remove?

---

### 2. Constants (src/constants.ts)

**Status**: ❌ UNUSED

```typescript
- isValidStreamId (line 94)
- isValidProjectId (line 103)
- DEFAULT_ANALYTICS_DATASET (line 78)
```

**Recommendation**:
- `isValidStreamId` / `isValidProjectId`: Remove or keep as internal utilities
- `DEFAULT_ANALYTICS_DATASET`: Remove if not used

**Action**: Remove or mark as internal (don't export)

---

### 3. Logging (src/log.ts)

**Status**: ❌ UNUSED

```typescript
- getLogger (line 60)
```

**Recommendation**:
- If not part of public API, don't export
- Keep internal to the module

**Action**: Remove from exports

---

### 4. Metrics (src/metrics/index.ts)

**Status**: ❌ UNUSED

```typescript
- createMetrics (line 148)
```

**Recommendation**:
- If not part of public API, don't export
- Keep internal to the module

**Action**: Remove from exports

---

### 5. Storage Barrel Exports (src/storage/index.ts)

**Status**: ⚠️ MANY UNUSED

The following are exported but never imported by external code:

```typescript
// Classes
- StreamDoStorage
- EstuaryDoStorage
- StreamSubscribersDoStorage

// Types
- StreamStorage, StreamMeta, ProducerState, SegmentRecord, ReadChunk
- OpsStats, CreateStreamInput, SegmentInput, BatchOperation, StreamMetaUpdate
- EstuaryStorage, Subscription, EstuaryInfo
- StreamSubscribersStorage, Subscriber, SubscriberWithTimestamp

// Functions (from registry)
- All registry functions listed above
- buildSegmentKey, encodeSegmentMessages, readSegmentMessages
- readFromOffset, readFromMessages
- emptyResult, errorResult, gapResult, dataResult
- ReadResult type
```

**Recommendation**:
- These are **internal storage APIs**
- Should NOT be exported from `src/storage/index.ts`
- Only export what `src/http/worker.ts` needs (which is: nothing from storage!)
- Storage classes are used internally by DOs
- Types like `ProjectEntry`, `StreamEntry` are re-exported by worker.ts

**Action**: Refactor `src/storage/index.ts` to not export these

---

### 6. Worker Exports (src/http/worker.ts)

**Status**: ✅ PARTIALLY UNUSED

```typescript
// Exported:
export { ServerWorker, StreamDO, StreamSubscribersDO, EstuaryDO, createStreamWorker }
export type { StreamIntrospection, BaseEnv, ProjectEntry, StreamEntry }

// Unused:
- default export (line 13)
- ProjectEntry (line 32) - unused
- StreamEntry (line 32) - unused
```

**Recommendation**:
- Keep `ServerWorker`, DOs, and `createStreamWorker` (public API)
- Keep types `BaseEnv`, `StreamIntrospection` (public API)
- Remove `ProjectEntry`, `StreamEntry` type exports (unused)
- Remove default export (unused)

**Action**: Clean up unused exports

---

### 7. Middleware Internals (src/http/middleware/*.ts)

**Status**: ✅ CORRECTLY INTERNAL

Several middleware exports marked "(used in module)":
- `extractBearerToken`, `verifyProjectJwt`, `verifyProjectJwtMultiKey` (authentication.ts)
- `COALESCE_LINGER_MS` (coalesce.ts)
- `parseGlobalCorsOrigins`, `resolveCorsOrigin` (cors.ts)
- `remainingTtlSeconds`, `ExpiryMeta` (expiry.ts)
- `parseStreamPath`, `ParsedStreamPath` (stream-path.ts)
- `appendServerTiming`, `TimingEntry` (timing.ts)

**Recommendation**: These are correctly internal. No changes needed.

---

## Action Plan

### Phase 0: Cleanup (Before Testing)

1. **Decide on registry functions**:
   ```bash
   # If keeping for planned admin API:
   # - Move to src/admin/ (not created yet)
   # - Document as "planned feature"
   
   # If removing:
   # - Delete from src/storage/registry.ts
   # - Remove exports from src/storage/index.ts
   ```

2. **Clean up constants.ts**:
   ```typescript
   // Remove unused exports or mark as internal
   // Don't export: isValidStreamId, isValidProjectId, DEFAULT_ANALYTICS_DATASET
   ```

3. **Clean up log.ts & metrics/index.ts**:
   ```typescript
   // Don't export: getLogger, createMetrics
   ```

4. **Refactor src/storage/index.ts**:
   ```typescript
   // Option A: Remove barrel file entirely (nothing should import from it)
   // Option B: Only export what's needed by worker.ts (seems to be nothing!)
   ```

5. **Clean up src/http/worker.ts**:
   ```typescript
   // Remove: default export, ProjectEntry, StreamEntry types
   ```

### Phase 1: Integration Tests (After Cleanup)

Focus on testing **public APIs via HTTP endpoints**, not internal functions.

See `COVERAGE_PLAN.md` for details.

---

## Verification Commands

```bash
# Find unused exports
npx ts-prune --project tsconfig.src.json | grep -v "(used in module)"

# Check if function is used
grep -r "functionName" src/ --include="*.ts" | grep -v "export"

# Find all exports
grep -r "^export" src/ --include="*.ts"

# Find imports from storage/
grep -r "from.*storage" src/ --include="*.ts"
```

---

## Notes

- This analysis used `ts-prune` which detects unused **exports**
- Some exports marked "(used in module)" are internal and correctly scoped
- The goal is to **remove/refactor before testing**, not test everything that exists
- Public API is minimal: `ServerWorker`, DOs, `createStreamWorker`, and types

---

## Questions for Team

1. **Registry functions**: Are these planned for an admin API? If yes, when? If no, remove?
2. **Storage exports**: Should `src/storage/index.ts` exist at all? Nothing seems to import from it.
3. **ProjectEntry/StreamEntry types**: Why are these re-exported from worker.ts if unused?
4. **Coverage target**: What's the acceptable coverage %? Focus on integration tests or unit tests?

---

## References

- ts-prune: https://github.com/nadeesha/ts-prune
- Coverage plan: See `COVERAGE_PLAN.md`
- Package exports: See `package.json` exports field
