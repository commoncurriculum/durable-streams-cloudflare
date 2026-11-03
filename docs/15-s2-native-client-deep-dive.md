# Chapter 15: S2 Native Client — Deep Dive with Authentication

This document provides an in-depth analysis of building a native S2 client library with authentication that matches the Durable Streams experience. This expands on "Option 3" from Chapter 14.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [S2 Authentication Model](#s2-authentication-model)
3. [Durable Streams Authentication Model (Current)](#durable-streams-authentication-model-current)
4. [Authentication Comparison](#authentication-comparison)
5. [Building the Auth Layer](#building-the-auth-layer)
6. [Complete Implementation Example](#complete-implementation-example)
7. [Migration Path](#migration-path)
8. [Recommendations](#recommendations)

---

## Executive Summary

**Key Finding**: S2 provides **granular access token management** with stream-level and operation-level permissions that can match or exceed Durable Streams' JWT-based auth experience.

**What S2 Provides:**
- ✅ Per-stream access control (via prefix or exact match)
- ✅ Operation-level permissions (read, write, manage operations)
- ✅ Programmatic token issuance/revocation
- ✅ Token expiration
- ✅ Basin-level namespacing (projects)

**What You'd Build:**
- A thin wrapper library that provides the same "point client at endpoint + JWT" experience
- The wrapper handles S2 token management under the hood
- Can maintain JWT interface for application compatibility

**Bottom Line**: You can achieve the same auth UX as Durable Streams with S2, but you'd be building a custom auth layer on top of S2's native token system rather than using JWT directly.

---

## S2 Authentication Model

### Access Token Structure

S2 uses **bearer tokens** issued through their API. The S2 SDK looks like this:

```typescript
import { S2 } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env.S2_ACCESS_TOKEN,  // Bearer token from S2 dashboard
});

const basin = s2.basin("my-project");  // Basin = namespace/project
const stream = basin.stream("chat-messages");

await stream.append(AppendInput.create([
  AppendRecord.string({ body: "Hello!" })
]));
```

### Access Token Scoping

S2 tokens have **fine-grained scopes** defined when issuing the token:

```typescript
interface AccessTokenScope {
  // Resource sets (which resources this token can access)
  basins?: ResourceSet | null;       // Which basins (projects)
  streams?: ResourceSet | null;      // Which streams
  accessTokens?: ResourceSet | null; // Sub-token management
  
  // Operation permissions (what actions are allowed)
  opGroups?: {
    account?: { read?: boolean; write?: boolean };
    basin?: { read?: boolean; write?: boolean };
    stream?: { read?: boolean; write?: boolean };
  };
  
  // Or explicit operation list
  ops?: Operation[];  // e.g., ['append', 'read', 'create-stream']
}

type ResourceSet = 
  | { exact: string }      // Match exactly "stream-123"
  | { prefix: string };    // Match all "user-alice-*"
```

**Example scopes:**

```typescript
// Read-only access to all streams in a basin
{
  streams: { prefix: "" },  // All streams
  opGroups: { stream: { read: true } }
}

// Write access to specific stream
{
  streams: { exact: "chat-room-5" },
  opGroups: { stream: { read: true, write: true } }
}

// Write access to user's streams (prefix-based isolation)
{
  streams: { prefix: "user-alice-" },
  opGroups: { stream: { read: true, write: true } }
}
```

### Token Issuance API

S2 provides programmatic token issuance:

```typescript
const s2 = new S2({ accessToken: ADMIN_TOKEN });

// Issue a new scoped token
const response = await s2.accessTokens.issue({
  id: "user-alice-session-123",  // Unique token ID
  scope: {
    streams: { prefix: "user-alice-" },
    opGroups: { stream: { read: true, write: true } }
  },
  expiresAt: new Date(Date.now() + 3600 * 1000),  // 1 hour
});

console.log(response.accessToken);  // The actual bearer token
// e.g., "s2_tkn_..."
```

### Token Lifecycle

- **Issuance**: Call `s2.accessTokens.issue()` with admin token
- **Usage**: Client includes token in `Authorization: Bearer <token>` header
- **Revocation**: Call `s2.accessTokens.revoke({ id: "..." })`
- **Expiration**: Automatic based on `expiresAt` timestamp
- **Listing**: `s2.accessTokens.list()` to see active tokens

---

## Durable Streams Authentication Model (Current)

### JWT Structure

Durable Streams uses **self-contained JWTs** signed with project secrets:

```typescript
// JWT payload
{
  sub: "my-project",         // Project ID
  scope: "read" | "write" | "manage",  // Permission level
  stream_id?: "doc-123",     // Optional: restrict to specific stream
  exp: 1234567890            // Expiration (Unix timestamp)
}
```

**Signing**: HMAC-SHA256 with project's `signingSecret` (stored in REGISTRY KV).

### Client Usage

```typescript
// Client-side (browser or server)
const jwt = generateJWT({
  sub: "my-project",
  scope: "write",
  exp: Math.floor(Date.now() / 1000) + 3600
}, PROJECT_SIGNING_SECRET);

// Make authenticated request
await fetch(`https://api.example.com/v1/stream/my-project/doc-123`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${jwt}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ message: "Hello" })
});
```

### Server-Side Verification

```typescript
// In Cloudflare Worker
export default {
  async fetch(request, env) {
    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "");
    
    // Lookup project config from KV
    const projectConfig = await env.REGISTRY.get(`project:${projectId}`);
    const { signingSecrets } = JSON.parse(projectConfig);
    
    // Verify JWT against signing secrets (supports key rotation)
    const claims = verifyJWT(token, signingSecrets);
    
    // Enforce scope
    if (claims.scope !== "write" && claims.scope !== "manage") {
      return new Response("Forbidden", { status: 403 });
    }
    
    // Enforce stream restriction (if present)
    if (claims.stream_id && claims.stream_id !== streamId) {
      return new Response("Forbidden", { status: 403 });
    }
    
    // Proceed with request...
  }
}
```

### Key Characteristics

- **Self-contained**: Token contains all authorization info
- **Stateless**: Server verifies signature, no token lookup needed
- **Client-side generation**: Clients can generate tokens if they have the secret
- **Key rotation**: Multiple signing secrets supported for zero-downtime rotation
- **Project isolation**: Each project has its own signing secret(s)

---

## Authentication Comparison

| Aspect | **Durable Streams (JWT)** | **S2 (Access Tokens)** |
|--------|---------------------------|------------------------|
| **Token Format** | Self-contained JWT (HMAC-SHA256) | Opaque bearer token (server-managed) |
| **Issuance** | Client-side (if secret available) or server-side | Server-side API call only |
| **Verification** | Signature check + claims validation | S2 API validates internally |
| **State** | Stateless (self-contained) | Stateful (S2 tracks tokens) |
| **Revocation** | Not possible (rely on expiration) | Instant via API (`s2.accessTokens.revoke()`) |
| **Granularity** | 3 scopes (read/write/manage) + optional stream_id | Fine-grained: per-resource + per-operation |
| **Stream Isolation** | Exact match only (`stream_id` claim) | Exact match OR prefix matching |
| **Key Rotation** | Multiple signing secrets | Token regeneration |
| **Client Experience** | `Authorization: Bearer <JWT>` | `Authorization: Bearer <S2_token>` |
| **Setup Complexity** | Generate/sign JWTs (crypto library) | Call S2 API to issue tokens |
| **Multi-tenant** | Project-scoped via `sub` claim | Basin-scoped (basin = project) |

### Capability Mapping

| Durable Streams Feature | S2 Equivalent | Implementation |
|------------------------|---------------|----------------|
| `scope: "read"` | `opGroups.stream.read: true` | ✅ Direct mapping |
| `scope: "write"` | `opGroups.stream.{read,write}: true` | ✅ Direct mapping |
| `scope: "manage"` | `ops: ['create-stream','delete-stream',...]` | ✅ Explicit op list |
| `stream_id: "doc-123"` | `streams: { exact: "doc-123" }` | ✅ Direct mapping |
| Optional stream restriction | Omit `stream_id` claim | ✅ Omit `streams` scope or use `prefix: ""` |
| JWT self-signing | N/A (API-issued only) | ❌ Not directly supported |
| Instant revocation | ❌ (rely on expiration) | ✅ `s2.accessTokens.revoke()` |

**Key Difference**: S2 tokens are **server-issued** (API call required), while Durable Streams JWTs can be **client-generated** (if client has signing secret). This affects the architecture.

---

## Building the Auth Layer

To match the Durable Streams UX ("point client at endpoint + JWT"), you'd build a **token service** that sits between your application and S2.

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Application Layer                        │
│  (Uses JWT like Durable Streams — no changes needed)        │
└──────────────┬───────────────────────────────────────────────┘
               │
               │ HTTP + Authorization: Bearer <JWT>
               ↓
┌──────────────────────────────────────────────────────────────┐
│                    Auth Proxy Service                        │
│  (Validates JWT, exchanges for S2 token, proxies request)   │
│                                                              │
│  1. Extract JWT from Authorization header                   │
│  2. Verify JWT signature with project's signing secret      │
│  3. Extract claims: projectId, scope, stream_id, exp        │
│  4. Check token cache (Redis/KV) for matching S2 token      │
│  5. If cache miss: issue new S2 token via s2.accessTokens   │
│  6. Forward request to S2 with S2 token                     │
└──────────────┬───────────────────────────────────────────────┘
               │
               │ HTTP + Authorization: Bearer <S2_token>
               ↓
┌──────────────────────────────────────────────────────────────┐
│                         S2 API                               │
│  (Validates S2 token, processes request)                    │
└──────────────────────────────────────────────────────────────┘
```

### Token Caching Strategy

**Why cache?** Avoid calling `s2.accessTokens.issue()` on every request (adds latency + S2 API cost).

**Cache key**: Hash of `(projectId, scope, stream_id, exp_bucket)`

```typescript
function getCacheKey(claims: JWTClaims): string {
  const exp_bucket = Math.floor(claims.exp / 300) * 300;  // 5-minute buckets
  return `s2-token:${claims.sub}:${claims.scope}:${claims.stream_id || '*'}:${exp_bucket}`;
}
```

**Cache storage options:**
- **Redis**: Best for multi-instance deployments (shared cache)
- **Cloudflare KV**: If proxy runs on CF Workers
- **In-memory (Map)**: Single-instance only, risk of churn on restarts

**TTL**: Set to JWT's `exp - now`, but cap at 5 minutes to allow revocation.

### JWT → S2 Token Mapping

```typescript
async function exchangeJWTForS2Token(
  jwt: string,
  projectConfig: ProjectConfig
): Promise<string> {
  // 1. Verify JWT
  const claims = verifyJWT(jwt, projectConfig.signingSecrets);
  if (!claims) throw new Error("Invalid JWT");
  
  // 2. Check cache
  const cacheKey = getCacheKey(claims);
  const cached = await cache.get(cacheKey);
  if (cached) return cached;
  
  // 3. Map JWT claims to S2 scope
  const s2Scope: AccessTokenScope = {
    streams: claims.stream_id 
      ? { exact: claims.stream_id }
      : { prefix: "" },  // All streams
    opGroups: {
      stream: {
        read: claims.scope === "read" || claims.scope === "write" || claims.scope === "manage",
        write: claims.scope === "write" || claims.scope === "manage",
      }
    }
  };
  
  // Add basin/stream management ops for "manage" scope
  if (claims.scope === "manage") {
    s2Scope.ops = [
      "create-stream", "delete-stream", "reconfigure-stream",
      "create-basin", "delete-basin", "reconfigure-basin"
    ];
  }
  
  // 4. Issue S2 token
  const s2Admin = new S2({ accessToken: projectConfig.s2AdminToken });
  const response = await s2Admin.accessTokens.issue({
    id: `jwt-${randomUUID()}`,  // Unique ID per token
    scope: s2Scope,
    expiresAt: new Date(claims.exp * 1000),  // Match JWT expiration
  });
  
  // 5. Cache S2 token
  const ttl = Math.min(claims.exp - Math.floor(Date.now() / 1000), 300);
  await cache.set(cacheKey, response.accessToken, { ttl });
  
  return response.accessToken;
}
```

### Proxy Implementation

```typescript
import { Hono } from "hono";
import { S2 } from "@s2-dev/streamstore";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  // Extract JWT from Authorization header
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing authorization" }, 401);
  }
  
  const jwt = authHeader.replace("Bearer ", "");
  
  // Determine project from URL (e.g., /v1/stream/{projectId}/...)
  const projectId = c.req.param("projectId");
  
  // Lookup project config (signing secrets, S2 admin token, S2 basin)
  const projectConfig = await c.env.REGISTRY.get(`project:${projectId}`, "json");
  if (!projectConfig) {
    return c.json({ error: "Project not found" }, 404);
  }
  
  // Exchange JWT for S2 token
  let s2Token: string;
  try {
    s2Token = await exchangeJWTForS2Token(jwt, projectConfig);
  } catch (error) {
    return c.json({ error: "Invalid token" }, 403);
  }
  
  // Store S2 token and project config in context for downstream handlers
  c.set("s2Token", s2Token);
  c.set("projectConfig", projectConfig);
  
  await next();
});

// Append endpoint
app.post("/v1/stream/:projectId/:streamId", async (c) => {
  const { projectId, streamId } = c.req.param();
  const s2Token = c.get("s2Token");
  const projectConfig = c.get("projectConfig");
  
  // Initialize S2 client with user's token
  const s2 = new S2({ accessToken: s2Token });
  const basin = s2.basin(projectConfig.s2Basin);
  const stream = basin.stream(streamId);
  
  // Parse request body
  const body = await c.req.arrayBuffer();
  
  // Append to S2
  const ack = await stream.append(
    AppendInput.create([
      AppendRecord.bytes({ body: new Uint8Array(body) })
    ])
  );
  
  return c.json({}, 204, {
    "Stream-Next-Offset": String(ack.end.seqNum),
  });
});

// Read endpoint
app.get("/v1/stream/:projectId/:streamId", async (c) => {
  const { projectId, streamId } = c.req.param();
  const offset = c.req.query("offset") || "0";
  const s2Token = c.get("s2Token");
  const projectConfig = c.get("projectConfig");
  
  const s2 = new S2({ accessToken: s2Token });
  const basin = s2.basin(projectConfig.s2Basin);
  const stream = basin.stream(streamId);
  
  // Read from S2
  const result = await stream.read({
    start: { from: { seqNum: parseInt(offset) } },
    stop: { limits: { count: 100 } },
  }, { as: "bytes" });
  
  // Concatenate records
  const combined = Buffer.concat(result.records.map(r => Buffer.from(r.body)));
  
  return c.body(combined, 200, {
    "Content-Type": "application/octet-stream",
    "Stream-Next-Offset": String(result.records[result.records.length - 1]?.seqNum || offset),
  });
});

export default app;
```

### Project Configuration

Each project needs:

```typescript
interface ProjectConfig {
  projectId: string;
  
  // JWT verification (existing)
  signingSecrets: string[];
  
  // S2 integration
  s2Basin: string;        // Which S2 basin maps to this project
  s2AdminToken: string;   // S2 token with permission to issue sub-tokens
}
```

**Storage**: REGISTRY KV (same as current system).

**Setup flow**:

1. User creates project in your dashboard
2. Dashboard creates S2 basin: `await s2.basins.create({ name: projectId })`
3. Dashboard issues S2 admin token with token issuance permission:
   ```typescript
   const adminToken = await s2.accessTokens.issue({
     id: `${projectId}-admin`,
     scope: {
       basins: { exact: projectId },
       streams: { prefix: "" },
       accessTokens: { prefix: `${projectId}-` },  // Can issue sub-tokens
       ops: ["issue-access-token", "revoke-access-token", "list-access-tokens"],
       opGroups: {
         basin: { read: true, write: true },
         stream: { read: true, write: true }
       }
     }
   });
   ```
4. Store in REGISTRY:
   ```typescript
   await REGISTRY.put(`project:${projectId}`, JSON.stringify({
     signingSecrets: [generatedSecret],
     s2Basin: projectId,
     s2AdminToken: adminToken.accessToken
   }));
   ```

---

## Complete Implementation Example

### Client Library Wrapper

For the best UX, wrap S2 SDK with Durable Streams-style interface:

```typescript
// @your-org/streams-client
import { S2, AppendInput, AppendRecord } from "@s2-dev/streamstore";

export class StreamsClient {
  private baseUrl: string;
  private jwt: string;
  
  constructor(baseUrl: string, jwt: string) {
    this.baseUrl = baseUrl;
    this.jwt = jwt;
  }
  
  stream(projectId: string, streamId: string) {
    return new StreamClient(this.baseUrl, this.jwt, projectId, streamId);
  }
}

class StreamClient {
  constructor(
    private baseUrl: string,
    private jwt: string,
    private projectId: string,
    private streamId: string
  ) {}
  
  async append(data: Uint8Array | string): Promise<{ offset: string }> {
    const response = await fetch(
      `${this.baseUrl}/v1/stream/${this.projectId}/${this.streamId}`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.jwt}`,
          "Content-Type": "application/octet-stream"
        },
        body: data
      }
    );
    
    if (!response.ok) throw new Error(`Append failed: ${response.status}`);
    
    const nextOffset = response.headers.get("Stream-Next-Offset");
    return { offset: nextOffset };
  }
  
  async read(offset: string = "0"): Promise<{ data: Uint8Array; nextOffset: string }> {
    const response = await fetch(
      `${this.baseUrl}/v1/stream/${this.projectId}/${this.streamId}?offset=${offset}`,
      {
        headers: {
          "Authorization": `Bearer ${this.jwt}`
        }
      }
    );
    
    if (!response.ok) throw new Error(`Read failed: ${response.status}`);
    
    const data = new Uint8Array(await response.arrayBuffer());
    const nextOffset = response.headers.get("Stream-Next-Offset");
    
    return { data, nextOffset };
  }
  
  async tail(onMessage: (data: Uint8Array) => void): Promise<() => void> {
    // Use EventSource for SSE
    const es = new EventSource(
      `${this.baseUrl}/v1/stream/${this.projectId}/${this.streamId}?live=sse`,
      {
        headers: {
          "Authorization": `Bearer ${this.jwt}`
        }
      }
    );
    
    es.onmessage = (event) => {
      const { payload } = JSON.parse(event.data);
      onMessage(new Uint8Array(Buffer.from(payload, "base64")));
    };
    
    return () => es.close();
  }
}

// Usage (identical to current Durable Streams!)
const client = new StreamsClient("https://streams.example.com", myJWT);
const stream = client.stream("my-project", "doc-123");

await stream.append("Hello, world!");
const { data } = await stream.read("0");
console.log(new TextDecoder().decode(data));

const cancel = await stream.tail((msg) => {
  console.log("New message:", new TextDecoder().decode(msg));
});
```

### Application Code (Zero Changes!)

```typescript
// User's application code — IDENTICAL to current Durable Streams
import { StreamsClient } from "@your-org/streams-client";

const jwt = generateJWT({
  sub: "my-project",
  scope: "write",
  stream_id: "doc-123",
  exp: Math.floor(Date.now() / 1000) + 3600
}, PROJECT_SECRET);

const client = new StreamsClient("https://streams.example.com", jwt);
const stream = client.stream("my-project", "doc-123");

await stream.append("Hello from S2!");
```

**No application changes needed** — the wrapper + proxy handle S2 translation transparently.

---

## Migration Path

### Phase 1: Proof of Concept (2 weeks)

1. **Deploy Auth Proxy** (Cloudflare Worker or VPS)
   - Implement JWT → S2 token exchange
   - Add token caching (KV or Redis)
   - Implement basic routes: POST (append), GET (read)

2. **Test with S2 Account**
   - Create test S2 account + basin
   - Issue admin token for token management
   - Verify auth flow end-to-end

3. **Measure Performance**
   - Latency: JWT verification + S2 token exchange + S2 API call
   - Cache hit rate
   - Cost: S2 API calls for token issuance

### Phase 2: Feature Parity (3 weeks)

4. **Implement All Endpoints**
   - PUT (create stream)
   - DELETE (delete stream)
   - HEAD (metadata)
   - SSE (live tailing)
   - Long-poll (if needed)

5. **Stream-Level Auth**
   - Map `stream_id` JWT claim to S2 `streams.exact` scope
   - Test enforcement

6. **Client Library**
   - Build `@your-org/streams-client` wrapper
   - Match existing Durable Streams client API
   - Add TypeScript types

### Phase 3: Production Readiness (2 weeks)

7. **Project Setup Flow**
   - Dashboard creates S2 basin per project
   - Issues S2 admin token
   - Stores in REGISTRY KV

8. **Monitoring & Alerts**
   - Auth proxy request rate, latency, errors
   - S2 token cache hit rate
   - S2 API error rate

9. **Load Testing**
   - 10K concurrent readers
   - Measure latency vs current DO implementation
   - Verify S2 token cache reduces latency

### Phase 4: Migration (4 weeks)

10. **Parallel Deployment**
    - Run S2 proxy alongside current DO infrastructure
    - Route test traffic to S2 proxy

11. **Gradual Cutover**
    - Migrate test projects
    - Monitor metrics
    - Fix issues

12. **Full Migration**
    - Update client library to point to S2 proxy by default
    - Deprecate DO infrastructure
    - Monitor for regressions

**Total: 11 weeks**

---

## Recommendations

### ✅ Pros of S2 Native with Auth Proxy

1. **Same UX**: Applications use JWTs exactly as before — zero code changes
2. **Better auth granularity**: S2's prefix-based stream scoping is more flexible than exact-match-only
3. **Instant revocation**: S2 tokens can be revoked immediately (JWTs cannot)
4. **Managed service**: No SQLite/R2/rotation management
5. **Multi-region**: S2 likely has better multi-region replication than DO
6. **Higher throughput**: S2 likely supports >200 batches/sec per stream

### ❌ Cons of S2 Native with Auth Proxy

1. **Added latency**: Proxy adds 10-50ms (JWT verify + token exchange/cache lookup + proxy hop)
2. **Added complexity**: Auth proxy is another service to deploy/monitor/scale
3. **Token issuance cost**: S2 API calls to issue tokens (mitigated by caching)
4. **Cache dependency**: Redis/KV needed for token cache (or accept higher latency)
5. **S2 pricing unknown**: Could be 3-10x more expensive than current $18/month
6. **No CDN caching**: Lose current CDN request collapsing unless rebuilt

### Decision Criteria

**Choose S2 Native with Auth Proxy if:**
- ✅ You need instant token revocation
- ✅ You need prefix-based stream scoping (e.g., `user-alice-*`)
- ✅ You need multi-region writes
- ✅ You need >200 batches/sec write throughput per stream
- ✅ S2 pricing is acceptable (verify first!)
- ✅ 50-150ms latency is acceptable (vs 10-50ms with DO)
- ✅ You're willing to manage an auth proxy service

**Stay with Durable Objects if:**
- ✅ Cost is critical ($18/month is hard to beat)
- ✅ You need <50ms write latency
- ✅ You have read-heavy workloads that benefit from CDN caching
- ✅ Exact-match stream scoping is sufficient
- ✅ Delayed revocation (via JWT expiration) is acceptable

### Hybrid Approach

**Use S2 for specific use cases:**
- High-throughput streams (analytics, logs)
- Multi-region collaborative editing
- Streams that need instant access revocation

**Use Durable Objects for:**
- Latency-sensitive real-time streams
- Read-heavy streams (leverage CDN caching)
- Cost-sensitive deployments

**Implementation**: Auth proxy routes to S2 or DO based on stream metadata flags.

---

## Conclusion

S2's access token system is **more powerful** than Durable Streams' simple JWT model — it provides:
- Granular resource scoping (prefix or exact)
- Fine-grained operation permissions
- Instant revocation
- Hierarchical token issuance

By building a lightweight **auth proxy** that exchanges JWTs for S2 tokens, you can:
- Preserve the existing client UX (point library at endpoint + JWT)
- Gain S2's benefits (managed service, multi-region, higher throughput)
- Maintain application compatibility (zero code changes)

The trade-off is:
- Added complexity (proxy service)
- Added latency (proxy hop + token exchange)
- Added cost (S2 subscription + proxy infrastructure)

**If operational simplicity and multi-region writes are worth 3-10x cost increase and 50ms latency increase, S2 with auth proxy is a solid choice.**

Otherwise, the current Durable Objects implementation is highly optimized for cost and latency.
