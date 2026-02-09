# Chapter 2: Cost Analysis and Design Drivers

Every major architectural decision in this system was driven by Cloudflare's billing model. This chapter documents the cost analysis that motivated the move from SSE-on-DO to WebSocket Hibernation, from Worker-only caching to CDN request collapsing, and ultimately to the VPS proxy architecture.

## Cloudflare Pricing Reference

| Resource | Rate | Included (Workers Paid $5/mo) |
|----------|------|-------------------------------|
| Worker requests | $0.30/M | 10M |
| DO requests | $0.15/M | 1M |
| DO duration | $12.50/M GB-seconds | 400K GB-s |
| DO WebSocket messages | incoming counted at 20:1 ratio | — |
| SQLite storage writes | $1.00/M rows written | — |
| SQLite storage | $0.20/GB-month | — |
| Cache API (`caches.default`) | **FREE** | unlimited |
| Bandwidth/egress | **$0** | unlimited |

Each DO gets 128 MB of memory, so one DO alive for one second = 0.125 GB-s.

## The DO Duration Problem

An open SSE response stream counts as an in-progress request — the DO **cannot hibernate** and stays fully billed for the entire connection duration.

At $12.50/M GB-seconds with 128 MB per DO:
- **1 DO alive 24/7 = ~$4.05/month** just in duration billing
- 1,000 concurrent SSE connections = 1,000 DOs that can never sleep

### Transport Cost Comparison (1,000 Concurrent Connections)

| Transport | DO State | Hourly Cost | Monthly (24/7) |
|-----------|----------|-------------|----------------|
| **SSE (direct to DO)** | Always awake | $5.79 | ~$4,170 |
| **Long-Poll** | Awake during 4s poll windows | $5.96 | ~$4,290 |
| **WebSocket + Hibernation** | Sleeps between writes | $0.06 | ~$43 |

WebSocket Hibernation is **~100x cheaper** because the DO only bills for the milliseconds of actual request processing (~10ms per write). Hibernation-eligible DOs are not billed even before the runtime has actually hibernated them.

### The Internal WebSocket Bridge

This cost analysis led directly to the architecture in Chapter 1:

```
Client <── SSE ──── Edge Worker <── WebSocket (Hibernation API) ──── StreamDO
                    (CPU-time billing,                                (sleeps between
                     idle = $0)                                       writes)
```

- Client sees standard SSE (no code changes needed)
- Edge worker holds the SSE stream (free — CPU-time billing, idle = $0)
- DO uses the Hibernation API — billing stops instantly when no active requests remain
- Write arrives → DO wakes for ~10ms → broadcasts WS message → sleeps
- **~100x cost reduction** vs SSE directly to DO

## Worker Request Cost Dominance

Even with Hibernation solving DO duration costs, Worker request volume dominates at scale.

At 10K concurrent readers with long-poll (1 request every 4s reconnect cycle):
- **Worker requests**: ~216K/min = 6.5B/month = **$1,950/month**
- DO requests at 91% cache HIT: 585M/month = $87.60
- DO requests at 99% cache HIT: 65M/month = $9.75

Improving HIT rate from 91% to 99% saves ~$78/month in a $2,000+ scenario. **The Worker request cost is the real problem, not DO requests.**

SSE/WebSocket eliminates repeated HTTP requests entirely, bringing the same scenario to ~$195/month.

## The CDN Insight: HITs = $0

Cloudflare CDN serves cached responses **without executing the Worker at all**. A CDN HIT costs $0 in Worker requests, $0 in DO requests, and $0 in bandwidth.

```
CDN HIT path:   Client → Cloudflare CDN → cached response ($0)
CDN MISS path:  Client → Cloudflare CDN → Worker → DO ($0.30/M + $0.15/M)
```

This changes the cost model entirely. With 99% CDN HIT rate, 10K long-poll readers generate:
- 6.5B requests/month total
- 65M CDN MISSes → Worker executions → **$19.50/month** in Worker requests
- 65M DO requests → **$9.75/month**
- 6.435B CDN HITs → **$0**

But `caches.default` (the Workers Cache API) does **not** provide CDN-level caching. It's per-datacenter and still requires the Worker to execute. To get true CDN caching, the request must go through a CDN-proxied hostname.

## Phase-by-Phase Cost Evolution

At 10K readers, 1 write/second, 30 days:

| Phase | Architecture | Worker Cost | DO Cost | Other | **Total/mo** |
|-------|-------------|-------------|---------|-------|-------------|
| Baseline | No caching | $7,800 | $3,900 | — | **$11,700** |
| Phases 1–3 | Deterministic cursors, `caches.default` only | $7,800 | $3,900 | — | **$11,700** |
| Phases 4–6 | Sentinel + stagger + WS bridge (91% HIT) | $7,800 | $345 | — | **$8,145** |
| **Phase 7 (optimistic)** | **CDN + VPS proxy (99% HIT)** | **$8** | **$4** | **$6 VPS** | **$18** |
| Phase 7 (pessimistic) | CDN + VPS proxy (79% HIT) | $78 | $8 | $6 VPS | **$92** |

The 650x cost reduction from $11,700 to $18 comes from two insights stacked together:
1. **WebSocket Hibernation** eliminates DO duration billing (~100x cheaper)
2. **CDN request collapsing** eliminates Worker execution for HITs (~100x cheaper again)

## Why the VPS Proxy Exists

Cloudflare CDN cannot proxy directly to a Cloudflare Worker — you can't point a CDN-proxied CNAME at a `*.workers.dev` domain. The VPS (nginx on a $6/month DigitalOcean droplet or free Oracle Cloud VM) exists solely to bridge this gap:

```
Client → Cloudflare CDN (ds-stream.commonplanner.com) → nginx (VPS) → Cloudflare Worker → DO
```

See Chapter 7 (CDN MISS Investigation) for a discussion of potentially eliminating this proxy via Workers Routes or Custom Domains.

## CDN Alternative Comparison

| Option | Monthly Cost (10K readers) | Notes |
|--------|---------------------------|-------|
| **Cloudflare CDN + $6 VPS** | **$18** | Current. CDN HITs = $0 |
| Oracle Cloud Free + CF CDN | $8 | Free VM, same architecture |
| Bunny CDN | ~$67 | Bandwidth-based pricing, no per-request charges |
| Cloudflare Enterprise | $5,078+ | No VPS needed, but $5K+ plan cost |
| CloudFront + VPS | ~$19,500 | $0.0075/10K requests even for HITs |

CloudFront is unusable because it charges per request even for cache hits. Cloudflare's model (CDN HITs = $0) is what makes the whole architecture viable.

## Fan-Out Write Amplification

For the subscription layer (Chapter 9), each publish fans out to N subscribers:

At 1–10 subscribers per stream (the actual use case for the text editor):
- 1 publish = 1–10 fan-out writes
- At $1/million rows written, this is ~$3/month at 1,000 messages/day with 100 average subscribers
- Write amplification is not a cost concern at this subscriber count

## Key Takeaway

The cost model drives the architecture:
1. **DO duration billing** → WebSocket Hibernation (DO sleeps between writes)
2. **Worker request volume** → CDN caching (HITs never reach the Worker)
3. **CDN HITs = $0** → VPS proxy to get traffic through the CDN layer
4. **Cloudflare-specific pricing** → Cloudflare CDN is uniquely suited (no per-request HIT charges)
