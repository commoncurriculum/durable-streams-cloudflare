# Chapter 17: S2 HTTP API & CDN Integration Strategies

This document addresses S2's REST API capabilities and explores strategies for enabling CDN caching with S2.

---

## Table of Contents

1. [S2 HTTP REST API (Correction)](#s2-http-rest-api-correction)
2. [CDN Integration with S2](#cdn-integration-with-s2)
3. [Protocol Transformation Strategy](#protocol-transformation-strategy)
4. [Implementation Options](#implementation-options)
5. [Recommendations](#recommendations)

---

## S2 HTTP REST API (Correction)

**Correction**: S2 **does** provide a full REST API. The SDK is optional.

### S2 REST API Endpoints

S2's REST API is documented and auto-generated via OpenAPI spec:

```
Base URL: https://{basin}.b.aws.s2.dev/v1
Auth: Authorization: ******
```

**Stream Operations:**

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/streams/{stream}/records` | Append records |
| `GET` | `/streams/{stream}/records` | Read records |
| `GET` | `/streams/{stream}/records/tail` | Check tail position |
| `POST` | `/streams` | Create stream |
| `DELETE` | `/streams/{stream}` | Delete stream |
| `GET` | `/streams/{stream}` | Get stream config |
| `PATCH` | `/streams/{stream}` | Reconfigure stream |
| `PUT` | `/streams/{stream}` | Create or reconfigure stream |

**Example HTTP Request (no SDK required):**

```bash
# Append records
curl -X POST https://my-basin.b.aws.s2.dev/v1/streams/my-stream/records \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{
    "records": [
      {"body": "SGVsbG8gV29ybGQ=", "headers": []}
    ]
  }'

# Read records
curl https://my-basin.b.aws.s2.dev/v1/streams/my-stream/records?start.from.seq_num=0&stop.limits.count=10 \
  -H "Authorization: ******"
```

### S2 HTTP API vs SDK

**HTTP API** (direct REST calls):
- ✅ No SDK dependency
- ✅ Works with any HTTP client (curl, fetch, etc.)
- ✅ Language-agnostic
- ❌ Manual request construction
- ❌ No built-in retry logic
- ❌ No type safety

**TypeScript SDK** (`@s2-dev/streamstore`):
- ✅ Type safety, IntelliSense
- ✅ High-level abstractions (appendSession, Producer)
- ✅ Built-in retry logic
- ✅ Async iterables for streaming
- ❌ Requires SDK installation
- ❌ TypeScript/JavaScript only

**Key insight**: S2's HTTP API is fully functional. The SDK is a convenience layer, not a requirement.

---

## CDN Integration with S2

### Challenge: S2's Default Architecture

S2's managed service model doesn't include CDN caching:

```
Client → S2 API (aws.s2.dev)
         └─ Managed infrastructure
```

**Why S2 doesn't use CDN by default:**

1. **Opaque bearer tokens** require server-side validation
2. **Managed service** handles scaling internally (no external CDN needed from S2's perspective)
3. **Real-time reads** via streaming protocols (SSE, HTTP/2)
4. **Per-request pricing** likely includes infrastructure costs

### Can S2 Be Made to Use a CDN?

**Yes**, but it requires building a caching proxy layer.

---

## Protocol Transformation Strategy

### Option A: S2 → Durable Streams Protocol Adapter

Build a translation layer that accepts Durable Streams HTTP requests and translates them to S2 API calls, preserving CDN caching semantics.

**Architecture:**

```
Client (DS protocol) → CF CDN → Protocol Adapter → S2 API
                       (caching)  (translation)
```

**Translation mapping:**

| Durable Streams Request | S2 API Call |
|------------------------|-------------|
| `PUT /v1/stream/{project}/{stream}` | `POST /streams/{stream}` |
| `POST /v1/stream/{project}/{stream}` | `POST /streams/{stream}/records` |
| `GET /v1/stream/{project}/{stream}?offset=X` | `GET /streams/{stream}/records?start.from.seq_num=X` |
| `GET ?offset=X&live=sse` | SSE session to S2 readSession |
| `GET ?offset=X&live=long-poll&cursor=Y` | S2 read with timeout + cursor handling |

**Implementation example:**

```typescript
// Cloudflare Worker: Durable Streams → S2 Adapter
import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

// Read endpoint with CDN caching
app.get("/v1/stream/:projectId/:streamId", async (c) => {
  const { projectId, streamId } = c.req.param();
  const offsetParam = c.req.query("offset") || "0";
  const cursor = c.req.query("cursor");
  const liveMode = c.req.query("live");
  
  // Auth: JWT → S2 token
  const jwt = c.req.header("Authorization")?.replace("Bearer ", "");
  const s2Token = await exchangeJWTForS2Token(jwt, c.env);
  
  // Decode Durable Streams offset to S2 seqNum
  const seqNum = decodeOffsetToSeqNum(offsetParam);
  
  // Build cache key (important for CDN HIT rate)
  const cacheKey = new Request(
    `${c.req.url}?offset=${offsetParam}&cursor=${cursor || ""}`,
    { method: "GET" }
  );
  
  // Check CDN cache
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const response = new Response(cached.body, cached);
    response.headers.set("X-Cache", "HIT");
    return response;
  }
  
  // Cache MISS: Call S2 API
  const s2Response = await fetch(
    `https://${projectId}.b.aws.s2.dev/v1/streams/${streamId}/records?start.from.seq_num=${seqNum}&stop.limits.count=100`,
    {
      headers: {
        "Authorization": `******,
        "Accept": "application/json"
      }
    }
  );
  
  if (!s2Response.ok) {
    return c.json({ error: "S2 API error" }, s2Response.status);
  }
  
  const s2Data = await s2Response.json();
  
  // Transform S2 response to Durable Streams format
  const dsBody = transformS2ToDurableStreams(s2Data);
  const nextOffset = encodeSeqNumToOffset(s2Data.next_seq_num);
  const upToDate = s2Data.records.length < 100;
  
  // Build response with Durable Streams headers
  const response = new Response(dsBody, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Stream-Next-Offset": nextOffset,
      "Stream-Up-To-Date": String(upToDate),
      "ETag": `"${seqNum}"`,
      "X-Cache": "MISS",
      // CDN caching headers
      "Cache-Control": upToDate && !liveMode
        ? "no-store"  // At-tail, plain GET: don't cache
        : "public, max-age=60",  // Mid-stream or long-poll: cache
    }
  });
  
  // Store in CDN cache (respecting Cache-Control)
  if (!response.headers.get("Cache-Control")?.includes("no-store")) {
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  
  return response;
});

// Append endpoint (no caching)
app.post("/v1/stream/:projectId/:streamId", async (c) => {
  const { projectId, streamId } = c.req.param();
  const jwt = c.req.header("Authorization")?.replace("Bearer ", "");
  const s2Token = await exchangeJWTForS2Token(jwt, c.env);
  
  const body = await c.req.arrayBuffer();
  
  // Call S2 append API
  const s2Response = await fetch(
    `https://${projectId}.b.aws.s2.dev/v1/streams/${streamId}/records`,
    {
      method: "POST",
      headers: {
        "Authorization": `******,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        records: [{ body: btoa(String.fromCharCode(...new Uint8Array(body))) }]
      })
    }
  );
  
  const s2Data = await s2Response.json();
  
  return c.json({}, 204, {
    "Stream-Next-Offset": encodeSeqNumToOffset(s2Data.ack.end.seq_num)
  });
});

// Helper functions
function decodeOffsetToSeqNum(offset: string): number {
  // DS offset format: "readSeq_byteOffset" or just number
  // Map to S2 seqNum
  if (offset === "-1" || offset === "now") return -1;
  const parts = offset.split("_");
  return parseInt(parts[parts.length - 1] || "0");
}

function encodeSeqNumToOffset(seqNum: number): string {
  // Simple mapping: use seqNum as offset
  // For full compatibility, could encode as "0_{seqNum}"
  return String(seqNum);
}

function transformS2ToDurableStreams(s2Data: any): Uint8Array {
  // Concatenate S2 records into single binary stream
  const buffers = s2Data.records.map((r: any) => 
    Buffer.from(r.body, "base64")
  );
  return Buffer.concat(buffers);
}

async function exchangeJWTForS2Token(jwt: string, env: Env): Promise<string> {
  // See Chapter 15 for full implementation
  // Validates JWT, exchanges for S2 token with caching
  // ...
  return "s2_token_...";
}

export default app;
```

**CDN Caching Behavior:**

With this adapter:
- ✅ **Mid-stream reads** cached (immutable data)
- ✅ **Long-poll reads** cached (cursor rotation prevents stale loops)
- ✅ **At-tail plain GETs** NOT cached (prevent read-after-write issues)
- ✅ **99% HIT rate achievable** (same as current Durable Streams)
- ✅ **162x cost reduction** preserved

---

### Option B: S2 Native with Caching Hints

Add Cache-Control headers to S2 responses via reverse proxy.

**Architecture:**

```
Client → CF CDN → Caching Proxy → S2 API
         (caching)  (adds headers)
```

**Implementation:**

```typescript
export default {
  async fetch(request: Request, env: Env) {
    // Forward to S2
    const s2Response = await fetch(request.url.replace(env.CDN_HOST, "aws.s2.dev"), {
      method: request.method,
      headers: request.headers,
      body: request.body
    });
    
    // Clone response to modify headers
    const response = new Response(s2Response.body, s2Response);
    
    // Add CDN caching headers based on request
    if (request.method === "GET" && request.url.includes("/records")) {
      const url = new URL(request.url);
      const seqNum = url.searchParams.get("start.from.seq_num");
      
      // Check if at tail (would need to call checkTail first)
      const atTail = false;  // Simplified
      
      if (!atTail) {
        // Mid-stream: safe to cache
        response.headers.set("Cache-Control", "public, max-age=60");
        response.headers.set("ETag", `"${seqNum}"`);
      } else {
        // At tail: don't cache
        response.headers.set("Cache-Control", "no-store");
      }
    }
    
    return response;
  }
}
```

**Challenges:**

- **At-tail detection**: S2 API doesn't distinguish mid-stream vs at-tail in read response
  - Would need separate `checkTail()` call (extra latency)
  - Or cache aggressively with short TTL (risk of stale reads)
  
- **Cursor rotation**: S2 doesn't have Durable Streams' cursor parameter
  - Can't prevent stale loops for long-poll
  - Would need custom cursor implementation in proxy

---

### Option C: Hybrid — Transform to Durable Streams Offsets

Keep S2 as storage, but emit Durable Streams protocol responses to leverage CDN caching.

**Architecture:**

```
Client (DS SDK) → CF CDN → Adapter → S2 API
                  (caching)  (transforms responses)
```

**Key design:**

1. **Offset encoding**: Map S2 seqNum to Durable Streams offset format
   - Simple: `offset = String(seqNum)`
   - Compatible: `offset = "0_{seqNum}"` (emulates segment format)

2. **Cursor rotation**: Add cursor parameter to requests
   - Adapter increments cursor on each response
   - Different cursor → different cache key

3. **At-tail detection**: Call S2's `checkTail()` to determine position
   - If `seqNum < tail`: mid-stream → cache
   - If `seqNum >= tail`: at-tail → don't cache (or use long-poll pattern)

4. **Cache-Control headers**: Adapter sets based on position
   - Mid-stream: `Cache-Control: public, max-age=60`
   - At-tail (plain GET): `Cache-Control: no-store`
   - Long-poll: `Cache-Control: public, max-age=20` + cursor rotation

**Benefits:**
- ✅ CDN caching enabled (99% HIT rate possible)
- ✅ Existing Durable Streams clients work unchanged
- ✅ S2's storage benefits (managed service, multi-region)

**Drawbacks:**
- ❌ Complex adapter layer (translation + cursor management)
- ❌ Extra latency (checkTail call for at-tail detection)
- ❌ Cost: S2 subscription + adapter infrastructure

---

## Implementation Options

### Option 1: Protocol Adapter Only (No CDN)

**Use case**: Simple migration to S2, don't care about CDN caching.

```
Client (DS protocol) → Protocol Adapter → S2 API
```

**Pros:**
- ✅ Clients unchanged
- ✅ S2's managed service benefits
- ✅ Simpler than full CDN integration

**Cons:**
- ❌ No CDN caching (all requests hit adapter → S2)
- ❌ Higher cost (no 162x CDN reduction)
- ❌ Higher latency (adapter + S2)

**Cost estimate**: S2 subscription + adapter VPS ($50-200/month S2 + $6/month VPS) = **$56-206/month**

---

### Option 2: Protocol Adapter + CDN Caching

**Use case**: Want S2's benefits AND CDN cost savings.

```
Client (DS protocol) → CF CDN → Protocol Adapter → S2 API
                       (99% HIT)  (translation + cursor management)
```

**Implementation**: See Option C code above.

**Pros:**
- ✅ CDN caching (99% HIT rate possible)
- ✅ 162x cost reduction preserved
- ✅ Existing clients work unchanged
- ✅ S2's managed service benefits

**Cons:**
- ❌ Complex adapter (translation, cursor rotation, at-tail detection)
- ❌ Extra latency (checkTail calls)
- ❌ Cost: S2 + adapter + development time

**Cost estimate**: 
- CDN HITs: $0 (6.4B requests/month)
- CDN MISSes: $8/month (Worker) + $4/month (adapter logic)
- VPS proxy: $6/month
- S2 subscription: $50-200/month
- **Total: $68-218/month**

Still 3-12x more expensive than current $18/month, but captures CDN benefits.

---

### Option 3: S2 Native + Cache Headers Proxy

**Use case**: Use S2 API directly, add minimal caching.

```
Client (S2 SDK/HTTP) → CF CDN → Cache Proxy → S2 API
                       (partial caching)  (adds headers)
```

**Pros:**
- ✅ Simpler adapter (just adds headers)
- ✅ Some CDN caching benefit
- ✅ Clients can use S2 SDK directly

**Cons:**
- ❌ Can't achieve 99% HIT rate (no cursor rotation)
- ❌ Risk of stale reads (no at-tail detection)
- ❌ Breaking change for existing clients

**Cost estimate**: $50-200/month (S2) + $6/month (proxy) + $8/month (Worker CDN MISSes) = **$64-214/month**

---

## Recommendations

### For Read-Heavy Workloads (Current Use Case)

**Recommendation: Keep Durable Streams (DO + CDN)**

**Reasoning:**
- Current $18/month is exceptional value
- 99% CDN HIT rate proven in production
- Adding S2 + adapter adds complexity and 3-12x cost
- No compelling benefit for read-heavy use case

**Only migrate to S2 if:**
- Need multi-region writes (DO is single-region)
- Need >200 batches/sec write throughput
- Operational overhead of DO is unacceptable

---

### For Write-Heavy Workloads

**Recommendation: S2 Direct (no CDN, no adapter)**

**Reasoning:**
- Write-heavy means CDN caching provides minimal benefit
- S2's appendSession/Producer APIs excel at high throughput
- Simpler architecture (no adapter layer)

**Implementation:**
- Use S2 HTTP API or TypeScript SDK directly
- Skip CDN/adapter complexity
- Accept S2's pricing model

---

### If You Must Have S2 + CDN Caching

**Recommendation: Option 2 (Protocol Adapter + CDN)**

**Implementation path:**
1. Build protocol adapter (2-4 weeks)
2. Implement cursor rotation for cache keys
3. Add checkTail logic for at-tail detection
4. Test CDN HIT rate (target 95%+)
5. Deploy behind Cloudflare CDN

**Cost**: $68-218/month (vs $18/month current)

**Only worthwhile if:**
- S2's features justify 3-12x cost increase
- Engineering time investment acceptable
- Alternative platforms not viable

---

## Conclusion

### Summary

1. **S2 does have an HTTP REST API** — SDK is optional
   - Full REST API at `https://{basin}.b.aws.s2.dev/v1`
   - Works with curl, fetch, any HTTP client
   - SDK provides convenience layer (types, retry, async iterables)

2. **S2 can be made CDN-compatible** — requires protocol adapter
   - Build translation layer: Durable Streams protocol → S2 API
   - Implement cursor rotation for cache keys
   - Add at-tail detection logic
   - Result: 99% CDN HIT rate achievable

3. **Cost-benefit analysis**:
   - **Current DO + CDN**: $18/month (read-heavy)
   - **S2 direct**: $50-200/month (write-heavy)
   - **S2 + CDN adapter**: $68-218/month (read-heavy with S2 benefits)

4. **Best approach depends on workload**:
   - Read-heavy → Keep DO + CDN ($18/month)
   - Write-heavy → S2 direct ($50-200/month)
   - Hybrid needs → S2 + adapter ($68-218/month)

### Decision Framework

```
Is workload read-heavy (reads >> writes)?
├─ Yes → Is $18/month acceptable?
│   ├─ Yes → Keep Durable Streams + CDN
│   └─ No → S2 + CDN adapter ($68-218/month)
└─ No (write-heavy) → Need >200 batches/sec or multi-region?
    ├─ Yes → S2 direct ($50-200/month)
    └─ No → Keep Durable Streams ($18/month)
```

The protocol adapter approach is **technically viable** but adds significant complexity. Only pursue if S2's specific features (multi-region, higher throughput, managed service) justify 3-12x cost increase and engineering investment.
