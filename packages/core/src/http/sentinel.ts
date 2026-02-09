/**
 * Cross-isolate sentinel coalescing + background WebSocket cache bridge.
 *
 * Optional module — only active when `edgeCoalescing: true` in StreamWorkerConfig.
 * Extends edge cache coalescing across all isolates in the same Cloudflare colo
 * by using caches.default as a coordination mechanism. Without a CDN in front,
 * this takes cache HIT rate from ~0% to ~86-90% under high concurrency.
 *
 * When a CDN handles request collapsing (Phase 7), this module is unnecessary
 * and should be left disabled.
 */

import {
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_CURSOR,
  HEADER_STREAM_NEXT_OFFSET,
  HEADER_STREAM_UP_TO_DATE,
  HEADER_STREAM_WRITE_TIMESTAMP,
  baseHeaders,
} from "../protocol/headers";
import { LONG_POLL_CACHE_SECONDS } from "../protocol/limits";
import type { StreamDO } from "./durable_object";
import type { WsDataMessage, WsControlMessage } from "./handlers/realtime";

// ============================================================================
// Constants
// ============================================================================

const SENTINEL_TTL_S = 30;
const POLL_INTERVAL_MS = 50;
const MAX_POLL_MS = 31_000;
// Random jitter before the sentinel check spreads concurrent arrivals so
// the first request can store the sentinel before the rest check.
// MISSes/write ≈ N × P / J (N = LP clients, P ≈ 10ms propagation, J = jitter).
// 20ms keeps average added latency to 10ms while providing meaningful spread.
const SENTINEL_JITTER_MS = 20;

// How long the background WS stays alive caching future write pushes.
const BRIDGE_BG_LIFETIME_MS = 25_000;

const textEncoder = new TextEncoder();

// ============================================================================
// Public interface
// ============================================================================

export interface SentinelContext {
  /** Non-null when another isolate already cached the result — return this as a HIT. */
  earlyResponse: Response | null;
  /** Call on DO error to clean up the sentinel marker. */
  cleanup(): void;
  /** Sync cache.put so polling isolates find the entry. Use instead of ctx.waitUntil. */
  cacheStore(url: string, response: Response): Promise<void>;
  /** Call after cache store — cleans up sentinel + starts WS bridge if applicable. */
  complete(
    stored: boolean,
    response: Response,
    stub: DurableObjectStub<StreamDO>,
    doKey: string,
    url: URL,
  ): void;
}

/**
 * Initialize sentinel coalescing for a long-poll cache miss.
 *
 * Checks caches.default for a sentinel marker. If one exists, polls for the
 * cached result (another isolate is fetching from the DO). If none exists,
 * sets the sentinel so this isolate becomes the "winner" for the colo.
 */
export async function initSentinel(
  cacheUrl: string,
  ctx: ExecutionContext,
): Promise<SentinelContext> {
  const sentinelUrl = cacheUrl + (cacheUrl.includes("?") ? "&" : "?") + "__sentinel=1";
  let existing = await caches.default.match(sentinelUrl);

  // Small jitter spreads concurrent arrivals so the first request
  // can store the sentinel before the rest check.
  if (!existing) {
    await new Promise((r) => setTimeout(r, Math.random() * SENTINEL_JITTER_MS));
    existing = await caches.default.match(sentinelUrl);
  }

  // Another isolate is already fetching — poll for the cached result
  if (existing) {
    const polled = await pollCacheForResult(cacheUrl, POLL_INTERVAL_MS, MAX_POLL_MS);
    return {
      earlyResponse: polled,
      cleanup() {},
      async cacheStore() {},
      complete() {},
    };
  }

  // We're the winner — set sentinel
  await caches.default.put(
    sentinelUrl,
    new Response(null, {
      headers: { "Cache-Control": `s-maxage=${SENTINEL_TTL_S}` },
    }),
  );

  return {
    earlyResponse: null,

    cleanup() {
      ctx.waitUntil(caches.default.delete(sentinelUrl));
    },

    async cacheStore(url: string, response: Response) {
      // Synchronous put so sentinel-polling isolates find the entry
      // on their next poll cycle (≤ POLL_INTERVAL_MS latency).
      await caches.default.put(url, response);
    },

    complete(
      stored: boolean,
      response: Response,
      stub: DurableObjectStub<StreamDO>,
      doKey: string,
      url: URL,
    ) {
      // Clean up sentinel marker
      ctx.waitUntil(caches.default.delete(sentinelUrl));

      // Start background WebSocket bridge for future write pushes
      if (stored) {
        const nextOffset = response.headers.get(HEADER_STREAM_NEXT_OFFSET);
        const nextCursor = response.headers.get(HEADER_STREAM_CURSOR);
        const contentType = response.headers.get("Content-Type") || "application/octet-stream";
        const isClosed = response.headers.get(HEADER_STREAM_CLOSED) === "true";
        if (nextOffset && !isClosed) {
          ctx.waitUntil(
            startBackgroundCacheBridge(stub, doKey, url, nextOffset, nextCursor, contentType),
          );
        }
      }
    },
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

async function pollCacheForResult(
  url: string,
  intervalMs: number,
  maxMs: number,
): Promise<Response | null> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const cached = await caches.default.match(url);
    if (cached) return cached;
  }
  return null;
}

/**
 * Background WebSocket cache bridge for long-poll sentinel winners.
 *
 * Opens a persistent WebSocket to the DO and caches every write push
 * at the URL that reconnecting long-poll clients will request next.
 * This runs as a fire-and-forget background task via ctx.waitUntil().
 *
 * The first response is always served via normal DO RPC — the bridge
 * only handles future writes. This avoids edge cases where the bridge
 * would return incorrect responses (missing cursor, wrong status on
 * delete, etc).
 */
async function startBackgroundCacheBridge(
  stub: DurableObjectStub<StreamDO>,
  doKey: string,
  url: URL,
  initialNextOffset: string,
  initialNextCursor: string | null,
  streamContentType: string,
): Promise<void> {
  const wsUrl = new URL(url);
  wsUrl.searchParams.set("live", "ws-internal");
  // Start from the offset we already served — the DO sends a catch-up
  // first, then pushes new writes.
  wsUrl.searchParams.set("offset", initialNextOffset);
  const wsReq = new Request(wsUrl.toString(), {
    headers: new Headers({ Upgrade: "websocket" }),
  });

  const wsResp = await stub.fetch(wsReq);

  if (wsResp.status !== 101 || !wsResp.webSocket) return;

  const ws = wsResp.webSocket;
  ws.accept();

  let done = false;
  let pendingData: ArrayBuffer | null = null;
  let nextOffset: string = initialNextOffset;
  let nextCursor: string | null = initialNextCursor;

  const lifetime = setTimeout(() => {
    done = true;
    try {
      ws.close(1000, "bridge lifetime");
    } catch {
      /* already closed */
    }
  }, BRIDGE_BG_LIFETIME_MS);

  ws.addEventListener("message", (event) => {
    if (done) return;
    try {
      const msg = JSON.parse(
        event.data as string,
      ) as WsDataMessage | WsControlMessage;

      if (msg.type === "data") {
        const dataMsg = msg as WsDataMessage;
        if (dataMsg.encoding === "base64") {
          const binary = Uint8Array.from(
            atob(dataMsg.payload),
            (c) => c.charCodeAt(0),
          );
          pendingData = binary.buffer as ArrayBuffer;
        } else {
          pendingData = textEncoder
            .encode(dataMsg.payload)
            .buffer as ArrayBuffer;
        }
        return;
      }

      // Control message — cache data if we have a pending payload
      const control = msg as WsControlMessage;

      if (pendingData && nextOffset) {
        const body = pendingData;
        pendingData = null;

        // Build the cache URL that reconnecting clients will request
        const bgUrl = new URL(url);
        bgUrl.searchParams.set("offset", nextOffset);
        if (nextCursor) bgUrl.searchParams.set("cursor", nextCursor);
        const bgCacheUrl = bgUrl.toString();

        // Build cacheable response headers
        const headers = baseHeaders({
          "Content-Type": streamContentType,
        });
        headers.set(HEADER_STREAM_NEXT_OFFSET, control.streamNextOffset);
        if (control.streamCursor)
          headers.set(HEADER_STREAM_CURSOR, control.streamCursor);
        if (control.upToDate)
          headers.set(HEADER_STREAM_UP_TO_DATE, "true");
        if (control.streamClosed)
          headers.set(HEADER_STREAM_CLOSED, "true");
        if (
          control.streamWriteTimestamp &&
          control.streamWriteTimestamp > 0
        ) {
          headers.set(
            HEADER_STREAM_WRITE_TIMESTAMP,
            String(control.streamWriteTimestamp),
          );
        }
        headers.set(
          "Cache-Control",
          `public, max-age=${LONG_POLL_CACHE_SECONDS}`,
        );

        // Cache response + proactive sentinel at the NEXT URL
        (async () => {
          try {
            await caches.default.put(
              bgCacheUrl,
              new Response(body.slice(0), {
                status: 200,
                headers: new Headers(headers),
              }),
            );
            // Proactive sentinel so reconnecting clients find a sentinel
            // instead of racing through the check-then-set window.
            if (
              control.streamNextOffset &&
              control.streamCursor &&
              !control.streamClosed
            ) {
              const sentUrl = new URL(url);
              sentUrl.searchParams.set("offset", control.streamNextOffset);
              sentUrl.searchParams.set("cursor", control.streamCursor);
              const sentSentinelUrl =
                sentUrl.toString() +
                (sentUrl.search ? "&" : "?") +
                "__sentinel=1";
              await caches.default.put(
                sentSentinelUrl,
                new Response(null, {
                  headers: {
                    "Cache-Control": `s-maxage=${SENTINEL_TTL_S}`,
                  },
                }),
              );
            }
          } catch {
            // Background cache failure is non-critical
          }
        })();

        nextOffset = control.streamNextOffset;
        nextCursor = control.streamCursor ?? null;

        if (control.streamClosed) {
          done = true;
          clearTimeout(lifetime);
          try {
            ws.close(1000, "stream closed");
          } catch {
            /* already closed */
          }
        }
      } else {
        // Control without data — just update tracking (catch-up/up-to-date)
        if (control.streamNextOffset) nextOffset = control.streamNextOffset;
        if (control.streamCursor) nextCursor = control.streamCursor;
        pendingData = null;
      }
    } catch {
      // Malformed message — ignore
    }
  });

  ws.addEventListener("close", () => {
    done = true;
    clearTimeout(lifetime);
  });

  ws.addEventListener("error", () => {
    done = true;
    clearTimeout(lifetime);
  });

  // Keep this promise alive for the lifetime of the WS
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (done) {
        clearInterval(check);
        resolve();
      }
    }, 1000);
  });
}
