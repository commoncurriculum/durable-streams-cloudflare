# Documentation Completeness Review

Review date: 2026-02-09

Scope: docs/00-index.md through docs/10-fan-in-streams.md (plus the unlisted docs/11-upstream-cache-comparison.md), compared against the actual codebase in packages/core/ and packages/subscription/.

---

## Topics That Are Well-Covered

### Core Architecture (Chapter 1)
Excellent coverage. The DO-per-stream model, SQLite hot log, R2 cold segments, request flow diagrams, data model (including full DDL), offset encoding, segment rotation, real-time delivery via internal WebSocket bridge, and DO hibernation are all documented accurately. The module map in Chapter 1 matches the actual file structure in `packages/core/src/`. The WebSocket message format and `WsAttachment` type are documented and match the code.

### Cost Analysis (Chapter 2)
Thorough. The pricing reference table, DO duration problem, transport cost comparison, phase-by-phase cost evolution, VPS proxy rationale, and CDN alternative comparison are all present. The cost model drives the architecture narrative convincingly.

### Cache Strategy Evolution (Chapters 3-6)
This is the most deeply documented area. The four-phase evolution from "cache everything" (broken) through "cache nothing" to the current design is told as a chronological investigation with commit references. Chapter 5's reference table of what gets cached vs not, with rationales, is a useful standalone reference. Chapter 6's historical record of sentinel coalescing and the WebSocket cache bridge (both removed) preserves important institutional knowledge.

### CDN MISS Investigation (Chapter 7)
Detailed production investigation with controlled experiments, root cause analysis (nginx IPv6 + Worker subrequest coalescing limitation), and clear recommendations. The distinction between external-client HIT rates (98-99%) and Worker subrequest HIT rates (79-83%) is well-articulated.

### Cache Test Coverage (Chapter 8)
Comprehensive 29-item checklist mapping every cache behavior to a specific test. Only one item is marked WEAK (SSE 60-second rotation, skipped due to miniflare limitations). This is an unusually strong testing doc.

### Upstream Comparison (Chapter 11)
Solid comparison against the upstream Durable Streams caching proposals. The architectural difference section at the end ("where caching happens") is the most valuable part -- it explains why many upstream proposals are irrelevant for the Cloudflare-native model.

---

## Gaps and Missing Topics

### 1. Chapter 00 (Index) is Missing Chapter 11

`docs/11-upstream-cache-comparison.md` exists but is not listed in `docs/00-index.md`. The index says "10 chapters" but there are 11.

**Severity**: Minor. Easy fix -- add it to the index.

### 2. Authentication and Authorization (Not Documented)

Authentication is a significant subsystem in both core and subscription but has no dedicated chapter or section beyond brief mentions in Chapters 1, 5, and 9.

What exists in code but is not documented in docs/:
- **Per-project JWT auth** (`packages/core/src/http/auth.ts`, `packages/subscription/src/http/auth.ts`): HS256 JWT verification with `sub`, `scope` (read/write), `exp`, and optional `stream_id` claims. Both packages implement this independently (code duplication).
- **KV-based project registry** (`REGISTRY` KV namespace): Stores per-project signing secrets. Used by both workers.
- **Scope-based access control**: Core distinguishes mutation vs read auth. Subscription maps actions (publish, subscribe, unsubscribe, getSession, touchSession, deleteSession) to required scopes.
- **Stream-scoped tokens**: The `stream_id` claim restricts a token to a specific stream.
- **Public stream bypass**: Core supports public streams via KV metadata (mentioned in Chapter 5 table but not explained).

Chapter 9 (Subscription Design) has an "Authentication and Authorization" section, but it describes a theoretical model ("server-minted or signed session IDs") rather than the actual implementation (per-project JWT with KV registry lookup).

**Severity**: High. Auth is a critical operational concern. Developers integrating with the system need to know how to mint JWTs, what claims are required, and how scope enforcement works.

### 3. The Subscription Implementation vs the Design Doc (Chapter 9)

Chapter 9 describes a design that differs substantially from what was actually built. The chapter reads as a pre-implementation design doc, not as documentation of the current system. Key discrepancies:

**What Chapter 9 describes (design):**
- Hub DO concept (`hub:<tenantId>:<shard>`) for live connections
- SSE/WebSocket live push from hub to connected tabs
- Client heartbeat with offset acking
- `session_subscriptions` and `session_offsets` tables (SQL DDL)
- `POST /v1/sessions` to create sessions
- `POST /v1/heartbeat` for offset tracking
- `GET /v1/session-offsets/<sessionId>` for offset retrieval
- Per-tab session IDs stored in `sessionStorage`
- "Hot push" (live delivery) + "cold catch-up" pattern
- Queue-based fan-out with fast/slow path threshold of 200

**What actually exists (code):**
- **No Hub DO**. There are two DOs: `SubscriptionDO` (per-stream, manages subscriber list) and `SessionDO` (per-session, tracks which streams a session subscribes to).
- **No live push**. The subscription worker does not hold SSE/WebSocket connections. Fan-out writes copies of the payload to each subscriber's session stream via core RPC. Clients read their session stream directly from the core worker.
- **No heartbeat endpoint**. Sessions use TTL-based expiry with touch (`POST /session/:sessionId/touch`).
- **No offset tracking**. The `session_offsets` table does not exist. Offsets are implicit -- each session has its own Durable Stream (via core) and clients read from their session stream's offset.
- **Different API surface**: The actual routes are `POST /subscribe`, `DELETE /unsubscribe`, `POST /publish/:streamId`, `GET /session/:sessionId`, `POST /session/:sessionId/touch`, `DELETE /session/:sessionId`.
- **Circuit breaker** for inline fanout (`SubscriptionDO`): closed/open/half-open states based on consecutive failure count. Not mentioned in Chapter 9.
- **Fanout producer deduplication**: Each subscription DO tracks a monotonic `fanoutSeq` and writes to session streams with producer headers (`fanout:<streamId>`, epoch=1, seq=N). Not mentioned in Chapter 9.
- **Stale subscriber cleanup**: Fan-out detects 404s from session streams (deleted/expired) and auto-removes those subscribers. Not mentioned in Chapter 9.
- **Analytics Engine integration**: Metrics for publish, fanout, subscribe, unsubscribe, session lifecycle, HTTP requests, and cleanup. Cleanup uses Analytics Engine SQL queries to find expired sessions. Not mentioned in Chapter 9.
- **Scheduled cleanup via cron**: `cleanupExpiredSessions()` runs on a cron trigger, queries Analytics Engine for expired sessions, removes subscriptions from each SubscriptionDO, and deletes session streams from core. Not mentioned in Chapter 9.
- **Queue-based fanout**: Implemented with configurable threshold (`FANOUT_QUEUE_THRESHOLD`), `FANOUT_QUEUE` binding, batched queue messages, and a queue consumer (`fanout-consumer.ts`). Chapter 9 mentions the concept but not the implementation details (base64 encoding, batch sizing, retry/ack logic).
- **Content-type matching enforcement**: Subscribe verifies the source stream's content type via `CORE.headStream` and ensures the session stream matches. Not in Chapter 9.
- **SessionDO**: A separate Durable Object per session that tracks which streams the session subscribes to. Not in Chapter 9.
- **Service binding RPC**: Subscription communicates with core via `WorkerEntrypoint` RPC methods (`CORE.postStream`, `CORE.putStream`, `CORE.headStream`, `CORE.deleteStream`), not HTTP. Chapter 9 doesn't describe the inter-service communication pattern.

**Severity**: Critical. Chapter 9 is a pre-implementation design sketch. The actual subscription system is substantially different and more sophisticated. Someone reading Chapter 9 would form an incorrect mental model of the system.

### 4. Chapter 10 (Fan-In Streams) Status Unclear

Chapter 10 is marked "Planned (not implemented)" but describes a detailed design including SQL DDL, HTTP API, subscribe/unsubscribe flows, envelope event format, and client consumption patterns. Some of the patterns described in Chapter 10 (like Session DO, subscribe/unsubscribe flows) overlap with what was actually built but in a different form.

The relationship between the Chapter 9 design, the Chapter 10 design, and the actual implementation is confusing. It appears that:
- Chapter 9 was the original design
- Chapter 10 was a proposed evolution
- The actual implementation took a different path from both

**Severity**: Medium. The "planned" label is clear, but the overlap with actual implementation patterns could mislead readers.

### 5. The Loadtest Package (Not Documented in docs/)

`packages/loadtest/` is a substantial package with its own README, a distributed mode using Cloudflare Workers at the edge, Analytics Engine integration, a CDN diagnostic tool (`diagnose-cdn.ts`), and JWT authentication. It is not mentioned anywhere in the docs/ chapters.

Chapter 7 (CDN MISS Investigation) references the loadtest results and reproduction commands but doesn't link to or explain the loadtest package itself.

**Severity**: Medium. The loadtest package has a good README, so it's self-documented. But the docs/ chapters form the canonical knowledge base for the system, and a testing/operational tool this significant should be referenced.

### 6. The Proxy Package (Partially Documented)

`packages/proxy/` (nginx reverse proxy) is mentioned in Chapters 2 and 7 in the context of the CDN architecture and the VPS cost model. Chapter 7 references `packages/proxy/nginx.conf.template` and `packages/proxy/README.md`. However, there is no dedicated documentation of:
- The actual nginx configuration details (IPv6 fix, resolver directives)
- The k8s/EKS deployment setup
- Why the proxy moved from DigitalOcean to EKS (or if it did)
- Operational considerations (monitoring, failover)

**Severity**: Low. The proxy package has its own README. The IPv6 fix is documented in Chapter 7. The operational details are deployment-specific.

### 7. The CLI Package (Not Documented in docs/)

`packages/cli/` is a setup wizard that scaffolds projects, creates Cloudflare resources (R2 buckets, KV namespaces), and deploys workers. It generates a pnpm workspace with per-worker packages. Not mentioned in docs/ at all.

**Severity**: Low. The CLI has its own README and is oriented toward library consumers, not internal developers.

### 8. The Admin Dashboards (Not Documented in docs/)

`packages/admin-core/` and `packages/admin-subscription/` are TanStack Start apps providing dashboards for core and subscription. They use service binding RPCs (not HTTP) to communicate with the backend workers. Not mentioned in docs/ chapters.

CLAUDE.md documents their architecture (server functions, route loaders, cloudflare:workers bindings, testing approach), but the design docs don't cover them.

**Severity**: Low. Admin dashboards are internal tooling. CLAUDE.md covers the development patterns.

### 9. Core RPC Interface (Not Documented)

The `CoreWorker` class in `packages/core/src/http/worker.ts` exports a rich RPC interface used by the subscription worker and admin dashboards:
- `headStream(doKey)`, `putStream(doKey, options)`, `deleteStream(doKey)`, `postStream(doKey, payload, contentType, producerHeaders)`
- `readStream(doKey, offset)`, `routeRequest(doKey, request)`, `inspectStream(doKey)`
- `registerProject(projectId, signingSecret)`

This is the inter-service API and is not documented in any design doc. Chapter 1 describes the HTTP API but not the RPC interface.

**Severity**: Medium. The RPC interface is how the subscription worker communicates with core. It's a critical integration surface.

### 10. Producer Fencing and Idempotency (Thin Coverage)

Chapter 1 mentions "Producer fencing and idempotency (epoch/seq)" in the module table and briefly describes producer header validation in the Append Flow. The actual implementation in `packages/core/src/stream/producer.ts` includes:
- Epoch comparison with stale epoch rejection (403)
- Sequence gap detection (409)
- Duplicate detection with idempotent 204 response
- Producer state TTL (7-day expiry)
- Producer ID pattern validation

This is a sophisticated subsystem that gets a single bullet point in Chapter 1.

**Severity**: Low-Medium. The protocol spec likely covers producer semantics. The design docs just need to explain the Cloudflare-specific implementation choices (TTL, pattern validation).

---

## Cost Chapter (Chapter 2) Completeness Assessment

### What Chapter 2 Covers Well
- Cloudflare pricing reference table
- DO duration billing problem and WebSocket Hibernation solution
- Transport cost comparison (SSE vs long-poll vs WebSocket+Hibernation)
- Worker request cost dominance at scale
- CDN HIT = $0 insight
- Phase-by-phase cost evolution ($11,700 to $18)
- VPS proxy rationale and alternatives
- Fan-out write amplification

### Cost Dimensions Missing from Chapter 2

1. **Subscription worker costs**: Chapter 2's cost model is entirely about the core worker. The subscription worker adds its own costs:
   - SubscriptionDO and SessionDO requests and duration
   - Queue message costs (if using `FANOUT_QUEUE`)
   - Analytics Engine write costs (every publish, fanout, subscribe, unsubscribe, session event writes a data point)
   - Analytics Engine query costs (cleanup cron queries AE for expired sessions and their subscriptions)
   - Cron trigger costs (scheduled cleanup runs every 5 minutes by default)

2. **KV costs**: Both core and subscription use a `REGISTRY` KV namespace for project signing secrets. KV reads are $0.50/M. Every authenticated request reads KV.

3. **R2 costs**: Chapter 2 mentions R2 as cold storage but doesn't include R2 pricing (Class A: $4.50/M operations, Class B: $0.36/M operations, storage: $0.015/GB-month). For high-write streams, segment rotation writes add up.

4. **Analytics Engine costs**: Core binds `METRICS` (Analytics Engine). The subscription worker writes data points for every HTTP request, publish, fanout, subscribe/unsubscribe, and session lifecycle event. AE is free on Workers Paid, but the write volume could be significant.

5. **SQLite storage write costs**: Mentioned in the pricing table ($1.00/M rows written) but not factored into the phase-by-phase cost model. Each append writes to `ops` and updates `stream_meta`. Fan-out writes amplify this.

### Cost Implications in Other Chapters That Should Be in Chapter 2

- **Chapter 7**: The VPS proxy adds latency (~16ms) and infrastructure cost. Chapter 2 mentions the $6/month VPS but Chapter 7 discusses potentially eliminating it via Workers Routes or Custom Domains, which would change the cost model.
- **Chapter 9**: Fan-out write amplification is mentioned in Chapter 2 but the actual implementation uses RPC calls to core (not direct SQLite writes), so the cost model is CORE service binding requests + CORE DO requests, not just SQLite row writes.

---

## Chronological Flow Assessment

The chronological ordering generally works for the cache investigation arc (Chapters 3-8). However:

1. **Gap between Chapter 1 and Chapter 2**: Chapter 1 (Architecture) describes the system as it is today. Chapter 2 (Cost Analysis) describes the cost evolution that motivated the architecture. Reading them in order, you learn the architecture first and then learn why it was designed that way. The suggested "end-to-end" reading order (1 -> 2 -> 9 -> 10) addresses this, but within the chapters themselves, Chapter 2 references "the architecture in Chapter 1" as if the reader already knows it.

2. **Chapters 3-8 are coherent as a cache investigation timeline**. The progression from research to evolution to current architecture to request collapsing to CDN testing to test coverage tells a complete story.

3. **Gap between Chapter 8 and Chapter 9**: Chapter 8 (Cache Test Coverage) closes the cache story. Chapter 9 (Subscription Design) opens a completely new topic with no transition. There is no chapter explaining how the subscription system was actually built, only the design sketch (Chapter 9) and a future plan (Chapter 10).

4. **Chapter 11 is orphaned**: Not in the index, not in the reading order. It's a comparison document that logically follows the cache chapters (5-8) but is numbered after the subscription chapters.

---

## Overall Assessment

### Strengths
- The cache investigation arc (Chapters 3-8) is exceptionally well-documented. The chronological narrative preserves decision rationale, failed experiments, and institutional knowledge that would otherwise be lost.
- Chapter 2 (Cost Analysis) is the strongest design doc. It shows the math, compares alternatives, and connects every architectural decision to a cost driver.
- Chapter 1 (Architecture) is an accurate reference for the core worker's current state.
- Historical decisions (sentinel coalescing, WebSocket cache bridge) are preserved with clear "removed" labels and the reasoning for removal.

### Weaknesses
- **The subscription documentation is the biggest gap.** Chapter 9 describes a design that was not built. The actual implementation (SubscriptionDO, SessionDO, fanout with circuit breaker, Analytics Engine cleanup, queue consumer, service binding RPC) is substantially different and undocumented.
- **Authentication has no dedicated documentation** despite being a critical subsystem in both packages.
- **The inter-service communication pattern** (core RPC via WorkerEntrypoint) is not documented anywhere in the design docs.
- **Operational concerns** (monitoring, debugging, deployment, the CLI setup wizard) are not covered in the design docs. These may be intentionally out of scope for "design documentation" but they're important for the system as a whole.

### Completeness Score

| Area | Score | Notes |
|------|-------|-------|
| Core architecture | 9/10 | Excellent. Minor gap on producer details and RPC interface. |
| Cost analysis | 7/10 | Strong for core, missing subscription/KV/R2/AE costs. |
| Cache strategy | 10/10 | Exhaustive. Best-documented area. |
| CDN investigation | 9/10 | Detailed. Missing link to loadtest package. |
| Test coverage | 9/10 | Comprehensive checklist with clear verdicts. |
| Subscription system | 3/10 | Design doc only. Actual implementation undocumented. |
| Authentication | 2/10 | Mentioned but not explained. |
| Inter-service communication | 1/10 | Not documented. |
| Operational tooling (loadtest, cli, admin, proxy) | 3/10 | READMEs exist but design docs don't reference them. |
| **Overall** | **6/10** | Strong core and cache docs; major gaps on subscription, auth, and operations. |

---

## Suggested Additions

### High Priority

1. **Rewrite Chapter 9** to document the actual subscription implementation. Cover:
   - The two-DO model (SubscriptionDO per stream, SessionDO per session)
   - The "session stream" pattern (each session is a Durable Stream in core)
   - Publish -> source write -> fanout flow
   - Inline vs queued fanout with configurable threshold
   - Circuit breaker for inline fanout
   - Fanout producer deduplication (monotonic sequence)
   - Stale subscriber auto-cleanup (404 detection)
   - Analytics Engine metrics schema
   - Scheduled cleanup via cron + AE queries
   - Content-type matching enforcement
   - The actual API surface (routes, request/response shapes)

2. **Add a chapter (or major section) on authentication**:
   - Per-project JWT model (HS256, claims: sub, scope, exp, stream_id)
   - KV registry for signing secrets
   - Scope enforcement (write vs read, action mapping in subscription)
   - Stream-scoped tokens
   - How to mint tokens for clients

### Medium Priority

3. **Document the core RPC interface** as used by subscription and admin packages. This is the inter-service contract.

4. **Expand Chapter 2** to include subscription worker costs, KV read costs, R2 operation costs, Analytics Engine write costs, and SQLite row write costs in the phase-by-phase model.

5. **Add Chapter 10 status update** or merge it into the rewritten Chapter 9. Clarify what was built vs what remains planned.

6. **Reference the loadtest package** from Chapter 7 and/or add it to the index as operational tooling.

### Low Priority

7. **Add Chapter 11 to the index** (00-index.md).

8. **Briefly reference the CLI, admin dashboards, and proxy** in the index or in a new "Operational Tooling" chapter.

9. **Document producer fencing** implementation details (TTL, epoch/seq semantics, duplicate response format) beyond the brief mention in Chapter 1.
