# @durable-streams-cloudflare/proxy

Nginx reverse proxy that serves as the origin for Cloudflare's CDN.

## Why This Exists

Cloudflare's CDN requires an origin server to proxy to — you can't point Cloudflare's CDN at a Cloudflare Worker directly via CNAME. This nginx instance runs on k8s and acts as that origin, forwarding requests through to the Workers.

The proxy is intentionally minimal: no caching, no auth, no buffering. It passes through all Durable Streams headers and keeps connections open long enough for long-poll and SSE.

## Configuration

The nginx config uses environment variables (substituted at container startup by the official nginx Docker image):

| Variable | Description |
|----------|-------------|
| `SERVER_NAME` | The hostname nginx listens for |
| `ORIGIN_HOST` | The upstream Workers hostname to proxy to |

## Build & Run

```bash
docker build -t durable-streams-proxy .
docker run -e SERVER_NAME=ds-stream.commonplanner.com \
           -e ORIGIN_HOST=durable-streams.<subdomain>.workers.dev \
           -p 80:80 durable-streams-proxy
```

## Tradeoffs

This proxy adds an extra hop: client -> Cloudflare edge -> nginx (k8s) -> Cloudflare Workers. For CDN-cacheable reads (source streams with multiple readers), Cloudflare's edge cache can absorb repeat requests before they reach nginx. For uncacheable reads (session streams with a single reader), every request passes through nginx as a no-op, adding latency proportional to the distance between nginx's region and the client.

Going direct to the Workers (bypassing the CDN and this proxy) would give clients globally distributed edge routing with no intermediate hop. The proxy is most valuable when CDN caching is actually doing work.
