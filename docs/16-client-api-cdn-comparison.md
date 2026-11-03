# Chapter 16: Client API Comparison & CDN Integration

This document provides a detailed comparison of Durable Streams and S2 client APIs, plus analysis of S2's CDN compatibility and caching capabilities.

---

## Table of Contents

1. [Client API Comparison](#client-api-comparison)
2. [Developer Experience Comparison](#developer-experience-comparison)
3. [S2 CDN & Caching Capabilities](#s2-cdn--caching-capabilities)
4. [Durable Streams CDN Architecture (Current)](#durable-streams-cdn-architecture-current)
5. [S2 + CDN Integration Strategy](#s2--cdn-integration-strategy)
6. [Recommendations](#recommendations)

---

## Client API Comparison

### Durable Streams Client API

**Architecture**: HTTP-based protocol, **no SDK required**. Clients use standard browser APIs (fetch, EventSource).

```typescript
// Durable Streams — Plain HTTP, no client library
const jwt = generateJWT({ sub: "project", scope: "write", exp: ... }, SECRET);

// Create stream
await fetch("https://api.example.com/v1/stream/project/my-stream", {
  method: "PUT",
  headers: { 
    "Authorization": `Bearer ${jwt}`,
    "Content-Type": "text/plain"
  },
  body: "Initial data"
});

// Append
const response = await fetch("https://api.example.com/v1/stream/project/my-stream", {
  method: "POST",
  headers: { 
    "Authorization": `Bearer ${jwt}`,
    "Content-Type": "text/plain"
  },
  body: "Hello, World!"
});
const nextOffset = response.headers.get("Stream-Next-Offset");

// Read (catch-up)
const readResponse = await fetch(
  `https://api.example.com/v1/stream/project/my-stream?offset=${offset}`,
  { headers: { "Authorization": `Bearer ${jwt}` } }
);
const data = await readResponse.arrayBuffer();
const newOffset = readResponse.headers.get("Stream-Next-Offset");

// Read (SSE tailing)
const eventSource = new EventSource(
  `https://api.example.com/v1/stream/project/my-stream?offset=${offset}&live=sse`,
  { headers: { "Authorization": `Bearer ${jwt}` } }  // Note: EventSource doesn't support custom headers in standard API
);

eventSource.onmessage = (event) => {
  const { payload, encoding } = JSON.parse(event.data);
  console.log("New message:", atob(payload));
};

// Read (long-poll)
const pollResponse = await fetch(
  `https://api.example.com/v1/stream/project/my-stream?offset=${offset}&live=long-poll&cursor=${cursor}`,
  { headers: { "Authorization": `Bearer ${jwt}` } }
);
```

**Key characteristics:**
- ✅ No client library dependency
- ✅ Works with any HTTP client (curl, fetch, axios, etc.)
- ✅ Standard browser APIs (EventSource for SSE)
- ✅ Protocol-correct Cache-Control headers
- ✅ Offset-based positioning (opaque strings)
- ❌ No typed SDK (manual header/query param management)

---

### S2 Client API

**Architecture**: **Native TypeScript SDK** (`@s2-dev/streamstore`) wrapping REST API.

```typescript
// S2 — SDK-based
import { S2, AppendInput, AppendRecord } from "@s2-dev/streamstore";

const s2 = new S2({
  accessToken: process.env.S2_ACCESS_TOKEN
});

const basin = s2.basin("my-project");

// Create stream
await basin.streams.create({ stream: "my-stream" });

const stream = basin.stream("my-stream");

// Append (single)
const ack = await stream.append(
  AppendInput.create([
    AppendRecord.string({ 
      body: "Hello, World!",
      headers: [["content-type", "text/plain"]]
    })
  ])
);
console.log(`Written at seqNum: ${ack.end.seqNum}`);

// Append (session for high-throughput)
const appendSession = await stream.appendSession({
  maxInflightBytes: 1024 * 1024
});

const ticket = await appendSession.submit(
  AppendInput.create([
    AppendRecord.string({ body: "Session record" })
  ])
);
const sessionAck = await ticket.ack();
await appendSession.close();

// Read (catch-up)
const batch = await stream.read({
  start: { from: { seqNum: 0 } },
  stop: { limits: { count: 100 } }
}, { as: "string" });

for (const record of batch.records) {
  console.log(record.seqNum, record.body);
}

// Read (SSE tailing)
const readSession = await stream.readSession({
  start: { from: { seqNum: ack.end.seqNum } }
  // No stop criteria = tail forever
}, { as: "string" });

for await (const record of readSession) {
  console.log("New:", record.seqNum, record.body);
}

// Read (with timeout)
const timedSession = await stream.readSession({
  start: { from: { seqNum: 0 } },
  stop: { waitSecs: 10 }
}, { as: "bytes" });

for await (const record of timedSession) {
  console.log(record.seqNum, record.body);
}
```

**Key characteristics:**
- ✅ Typed TypeScript SDK (IntelliSense, type safety)
- ✅ High-level abstractions (AppendSession, ReadSession, Producer)
- ✅ Built-in retry logic configurable
- ✅ Async iterables (modern async/await patterns)
- ✅ Sequence numbers (numeric) vs opaque offsets
- ✅ Timestamp-based reads (not just seqNum)
- ❌ Requires SDK installation (not plain HTTP)
- ❌ SDK adds bundle size (~50KB minified)

---

### API Feature Comparison

| Feature | Durable Streams | S2 |
|---------|----------------|-----|
| **Client Dependency** | None (plain HTTP) | SDK required (`@s2-dev/streamstore`) |
| **Type Safety** | ❌ (manual HTTP) | ✅ (TypeScript SDK) |
| **Create Stream** | `PUT /stream/{project}/{id}` | `basin.streams.create({ stream: "..." })` |
| **Append** | `POST /stream/{project}/{id}` | `stream.append(AppendInput.create([...]))` |
| **Read (catch-up)** | `GET ?offset=X` | `stream.read({ start, stop })` |
| **Read (SSE)** | `GET ?live=sse` (EventSource) | `stream.readSession()` (async iterable) |
| **Read (long-poll)** | `GET ?live=long-poll&cursor=Y` | `readSession({ stop: { waitSecs: N } })` |
| **Position Format** | Opaque offset string (`0_123`) | Numeric seqNum (bigint) |
| **Timestamp Reads** | ❌ | ✅ `start: { from: { timestamp: Date } }` |
| **Batching** | Manual (send array as JSON) | `AppendInput.create([record1, record2])` |
| **High-throughput API** | ❌ | ✅ `appendSession()` with pipelining |
| **Producer API** | Producer-Id/Epoch/Seq headers | `Producer` class with auto-batching |
| **Retry Policy** | Manual | Configurable (`appendRetryPolicy`) |
| **Idempotency** | Producer headers + Stream-Seq | `matchSeqNum` in AppendInput |
| **Headers** | Custom (e.g., `Stream-Next-Offset`) | SDK abstracts (returns objects) |

---

## Developer Experience Comparison

### Durable Streams: HTTP-First

**Pros:**
- ✅ **Zero dependencies**: Works with curl, Postman, any HTTP client
- ✅ **Standard protocols**: EventSource, fetch, standard HTTP headers
- ✅ **CDN-friendly**: Protocol designed for caching (Cache-Control, ETag)
- ✅ **Polyglot**: Any language with HTTP support works immediately
- ✅ **Transparent**: Inspect traffic with browser DevTools, Wireshark, etc.

**Cons:**
- ❌ **No type safety**: Manual header/param construction, easy to make mistakes
- ❌ **Verbose**: Every operation requires full HTTP request setup
- ❌ **No abstractions**: Manual batching, retry logic, session management
- ❌ **EventSource limitations**: Can't set custom headers (auth via query param or cookie)

**Example complexity (Durable Streams):**
```typescript
// Append with producer headers (idempotency)
await fetch(url, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${jwt}`,
    "Content-Type": "application/json",
    "Producer-Id": "writer-1",
    "Producer-Epoch": "0",
    "Producer-Seq": "5"
  },
  body: JSON.stringify([{ op: "insert", text: "..." }])
});
```

---

### S2: SDK-First

**Pros:**
- ✅ **Type safety**: Compile-time checking, IntelliSense
- ✅ **Ergonomic**: High-level abstractions (append/read sessions, producer, retry)
- ✅ **Modern patterns**: Async iterables, promises, auto-batching
- ✅ **Retry built-in**: Configurable retry policies, timeout handling
- ✅ **Documentation**: JSDoc comments, typed parameters

**Cons:**
- ❌ **SDK dependency**: Must install `@s2-dev/streamstore` (bundle size impact)
- ❌ **Language-specific**: TypeScript SDK only (other languages: call REST API directly or build own SDK)
- ❌ **Abstraction layer**: Harder to debug HTTP-level issues
- ❌ **Version coupling**: SDK version must match S2 API version

**Example simplicity (S2):**
```typescript
// Same idempotency, much simpler
const producer = new Producer(
  new BatchTransform({ lingerDurationMillis: 25 }),
  await stream.appendSession()
);

await producer.submit(AppendRecord.string({ body: "..." }));
```

---

## S2 CDN & Caching Capabilities

### Does S2 Support CDN Caching?

**Short answer: S2 is designed for direct API access, NOT CDN caching.**

Based on S2's architecture:

1. **Access tokens are opaque bearer tokens** (not self-contained like JWTs)
   - S2 API validates tokens server-side on every request
   - CDN cannot validate tokens → cannot serve cached responses

2. **No Cache-Control headers in SDK documentation**
   - S2's REST API docs don't mention Cache-Control or ETag headers
   - SDK focuses on programmatic access (sessions, retries), not HTTP caching

3. **Managed service model**
   - S2 handles scaling internally (no need for external CDN)
   - Pricing likely includes infrastructure costs

4. **Read sessions use streaming transport**
   - S2's `readSession()` uses HTTP/2 streaming or SSE
   - Not compatible with typical CDN caching (partial responses, chunked encoding)

### S2 Architecture (Inferred)

```
Client → S2 API (managed service)
         ↓
   S2's internal infrastructure
   (likely distributed, multi-region)
         ↓
   Durable storage
```

**No CDN layer** — S2 is the API endpoint directly.

---

## Durable Streams CDN Architecture (Current)

### Request Collapsing via CDN

Durable Streams is **explicitly designed for CDN caching**:

```
Client → Cloudflare CDN → VPS Proxy → CF Worker → Durable Object
         └─ 99% HIT rate           └─ Auth/routing  └─ SQLite/R2
         └─ $0 cost per HIT
```

### Key CDN Optimizations

1. **Immutable mid-stream reads**
   - `GET ?offset=100` returns same data forever (offset never changes)
   - Cache-Control: `public, max-age=60, stale-while-revalidate=300`
   - **Perfect for CDN**: 1M readers share one cached response

2. **Long-poll cursor rotation**
   - `GET ?offset=100&live=long-poll&cursor=2000`
   - Cursor increments on every response → new cache key
   - Prevents stale loops while enabling collapsing
   - **99% HIT rate**: 10K readers collapse to 1 DO hit per 4-second cycle

3. **ETag revalidation**
   - `If-None-Match` returns 304 if cached ETag matches
   - No DO call needed for revalidation

4. **At-tail detection**
   - Plain GET at tail NOT cached (breaks read-after-write)
   - Long-poll at tail IS cached (cursor rotation prevents staleness)

### Cost Impact

**With CDN caching** (current):
- 10K readers, 1 write/sec, 30 days
- 6.5B requests/month total
- 99% CDN HIT rate = 6.4B HITs at **$0**
- 65M MISSes = $19.50 Worker requests + $9.75 DO requests
- **Total: $18/month**

**Without CDN caching**:
- All 6.5B requests hit Worker
- Worker: $1,950/month
- DO: $975/month
- **Total: $2,925/month**

**CDN caching provides 162x cost reduction.**

---

## S2 + CDN Integration Strategy

If you use S2 and want CDN-level caching, you'd need to **build a caching proxy**.

### Option A: S2 Direct (No CDN)

```
Client → S2 API
```

**Pros:**
- ✅ Simplest architecture
- ✅ S2 handles all scaling

**Cons:**
- ❌ Every request hits S2 API (cost per request)
- ❌ No request collapsing for read-heavy workloads
- ❌ Latency includes S2 round-trip (50-150ms)

**Cost model**: Depends on S2 pricing (unknown).

---

### Option B: S2 + Caching Proxy

```
Client → Cloudflare CDN → Caching Proxy → S2 API
         (free HITs)        (translates tokens, caches responses)
```

**Implementation:**

```typescript
// Cloudflare Worker caching proxy
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    
    // Extract auth
    const jwt = request.headers.get("Authorization")?.replace("Bearer ", "");
    const claims = verifyJWT(jwt, env.PROJECT_SECRET);
    
    // For reads, check CDN cache
    if (request.method === "GET") {
      const cache = caches.default;
      
      // Build cache key (include auth context)
      const cacheKey = new Request(request.url, {
        method: "GET",
        headers: { "X-Auth-User": claims.sub }
      });
      
      const cached = await cache.match(cacheKey);
      if (cached) {
        return cached.clone();
      }
      
      // Cache miss: fetch from S2
      const s2Token = await exchangeJWTForS2Token(jwt, env);
      const s2 = new S2({ accessToken: s2Token });
      
      // Extract offset from URL
      const offset = url.searchParams.get("offset") || "0";
      const seqNum = parseInt(offset);
      
      const batch = await s2.basin(claims.sub).stream(streamId).read({
        start: { from: { seqNum } },
        stop: { limits: { count: 100 } }
      });
      
      // Serialize to HTTP response
      const body = Buffer.concat(batch.records.map(r => Buffer.from(r.body)));
      const response = new Response(body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Stream-Next-Offset": String(batch.records[batch.records.length - 1]?.seqNum || seqNum),
          "Cache-Control": "public, max-age=60",  // Cache at CDN
          "ETag": `"${seqNum}"`
        }
      });
      
      // Store in CDN cache
      await cache.put(cacheKey, response.clone());
      
      return response;
    }
    
    // For writes, proxy directly to S2 (no caching)
    const s2Token = await exchangeJWTForS2Token(jwt, env);
    // ... forward to S2
  }
}
```

**Challenges:**

1. **S2 doesn't return Cache-Control headers** (inferred)
   - Proxy must add headers based on response semantics
   - Risk of caching stale data if offset semantics differ

2. **Offset format mismatch**
   - Durable Streams: `0_123` (segment_offset)
   - S2: numeric seqNum
   - Proxy must translate

3. **SSE/readSession caching**
   - S2's streaming reads aren't cacheable
   - Would need to poll S2 and cache individual batches

4. **Token exchange overhead**
   - Every cache miss requires JWT → S2 token exchange
   - Mitigated by token caching (see Chapter 15)

---

### Option C: Hybrid (S2 for Writes, DO for Reads)

```
Writes → S2 API (high throughput)
Reads  → Durable Objects (CDN caching)
         ↓
   Background sync: S2 → DO
```

**Use case**: Leverage S2's write scalability + DO's read caching.

**Complexity**: High (dual storage, sync lag, consistency challenges).

---

## Recommendations

### Use S2 Native Client (No CDN) If:

✅ **Write-heavy workload** (writes >> reads)
- CDN caching provides minimal benefit
- S2's appendSession + Producer APIs excel at high throughput

✅ **Multi-region writes required**
- S2 likely has better multi-region replication than single-region DO

✅ **Operational simplicity > cost**
- Managed service (no SQLite/R2/rotation management)
- Higher cost acceptable

✅ **Want typed SDK experience**
- S2's TypeScript SDK is well-designed
- Better DX than manual HTTP

**Cost estimate**: $50-200/month (S2 subscription) + per-request costs

---

### Keep Durable Streams (with CDN) If:

✅ **Read-heavy workload** (reads >> writes)
- CDN caching provides 100x+ cost reduction
- Current: $18/month for 10K readers

✅ **Cost is critical**
- Hard to beat $18/month with managed service

✅ **Latency <50ms required**
- Same-region DO: 10-50ms
- S2: 50-150ms (external API)

✅ **Polyglot clients**
- Plain HTTP works everywhere
- No SDK dependency

✅ **Existing CDN infrastructure**
- Already using Cloudflare CDN
- Protocol designed for caching

**Cost**: $18/month (current)

---

### Build S2 + Caching Proxy If:

✅ **Need S2's features** (multi-region, high throughput, managed service)

✅ **Also need cost efficiency** (read-heavy workload)

✅ **Engineering resources available** (build/maintain proxy)

**Complexity**: High
**Cost**: $50-200/month (S2) + $6-20/month (proxy VPS) + development time

---

## Client API Recommendation

### For New Projects

**If backwards compatibility doesn't matter:**

**Use S2 Native SDK** if you want:
- Modern TypeScript DX (type safety, async iterables)
- Built-in high-throughput APIs (appendSession, Producer)
- Managed service benefits
- Don't need CDN caching (write-heavy or cost not critical)

**Use Durable Streams HTTP** if you want:
- Polyglot support (any HTTP client)
- CDN caching benefits (read-heavy, cost-critical)
- Zero client dependencies
- Sub-50ms latency (same-region DO)

---

### Client API Migration Path

If you choose S2 but want Durable Streams-like HTTP API:

**Build a thin HTTP wrapper** over S2 SDK:

```typescript
// Your wrapper library
export class StreamClient {
  async append(url: string, data: string | Uint8Array): Promise<string> {
    // Extract basin/stream from URL
    const { basin, stream } = parseUrl(url);
    
    // Use S2 SDK under the hood
    const s2Stream = this.s2.basin(basin).stream(stream);
    const ack = await s2Stream.append(
      AppendInput.create([
        typeof data === "string"
          ? AppendRecord.string({ body: data })
          : AppendRecord.bytes({ body: data })
      ])
    );
    
    return String(ack.end.seqNum);  // Return offset
  }
}
```

This gives you:
- Durable Streams-like API surface
- S2's TypeScript SDK benefits under the hood
- Easier migration from HTTP-first code

---

## Conclusion

### Client API

| Aspect | **Durable Streams** | **S2** |
|--------|-------------------|--------|
| **Approach** | HTTP-first (no SDK) | SDK-first (TypeScript) |
| **Best for** | Polyglot, zero deps, CDN caching | Type safety, high throughput, managed service |
| **DX** | Manual but transparent | Ergonomic but opaque |
| **Similarity** | Different philosophies | Different philosophies |

**Answer**: The APIs are **substantially different**. S2 is SDK-first with high-level abstractions; Durable Streams is HTTP-first with protocol transparency.

**If you prefer Durable Streams' HTTP-first approach**, you can build a thin wrapper over S2 SDK or use the protocol adapter (Chapter 14, Option 2).

**If you're okay with SDK-first**, S2's native API is well-designed and modern.

---

### CDN Integration

| Aspect | **Durable Streams** | **S2** |
|--------|-------------------|--------|
| **CDN support** | Designed for CDN caching | Not designed for CDN |
| **Request collapsing** | 99% HIT rate via cursor rotation | No built-in CDN support |
| **Cost benefit** | 100x+ reduction ($18 vs $2,925) | N/A (managed service pricing) |
| **Architecture** | Edge cache → Worker → DO | Client → S2 API |

**Answer**: Durable Streams has **clever offset/cursor design** that enables aggressive CDN caching. S2 does **not** have equivalent CDN support.

**If CDN caching is critical** (read-heavy workload, cost-sensitive):
- Stay with Durable Streams, or
- Build caching proxy on top of S2 (complex)

**If CDN caching isn't needed** (write-heavy, cost not critical):
- S2 direct is simpler

---

### Final Recommendation

**For your use case** (not in production, backwards compat not an issue):

**Option 1: S2 Native SDK** (if you prefer SDK DX and don't need CDN caching)
- Use `@s2-dev/streamstore` directly
- Simplest path
- Cost: S2 subscription (verify pricing first!)

**Option 2: Durable Streams HTTP** (if you need CDN caching or ultra-low latency)
- Keep current architecture
- Cost: $18/month (proven)

**Option 3: S2 + Auth Proxy** (if you want S2's superior auth + preserve JWT UX)
- See Chapter 15 for complete implementation
- Cost: S2 subscription + proxy infrastructure

**Do NOT build**: S2 + full CDN proxy (too complex for uncertain benefit)

**Next steps**:
1. Verify S2 pricing at your target scale
2. Test S2's latency from your regions
3. Decide based on cost/latency trade-off vs current $18/month DO setup
