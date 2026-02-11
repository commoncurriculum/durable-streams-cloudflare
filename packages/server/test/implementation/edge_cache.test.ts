import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../src/http/v1/streams/shared/offsets";
import { createClient, delay, uniqueStreamId, waitForCacheHit } from "./helpers";

// Small delay for negative cache tests: long enough for a cache write
// (fire-and-forget via waitUntil) to settle if it were going to happen.
const CACHE_SETTLE_MS = 100;

describe("edge cache", () => {
  const client = createClient();

  // ================================================================
  // Cache store policy — what gets stored in the cache
  // ================================================================
  describe("cache store policy", () => {
    it("caches mid-stream GET reads", async () => {
      const streamId = uniqueStreamId("cache-mid");

      // Multiple appends so that readFromOffset hits maxChunkBytes between ops.
      // A single large block is always returned whole (first-chunk exception),
      // so we need separate operations that sum to >256KB.
      const chunk = "a".repeat(100 * 1024); // 100KB per append
      await client.createStream(streamId, chunk, "text/plain");
      await client.appendStream(streamId, chunk, "text/plain");
      await client.appendStream(streamId, chunk, "text/plain");

      const url = client.streamUrl(streamId, { offset: ZERO_OFFSET });

      const first = await fetch(url);
      expect(first.status).toBe(200);
      expect(first.headers.get("Stream-Up-To-Date")).not.toBe("true");
      expect(first.headers.get("X-Cache")).toBe("MISS");
      await first.arrayBuffer();

      const second = await waitForCacheHit(url);
      expect(second.status).toBe(200);
      expect(second.headers.get("X-Cache")).toBe("HIT");
      await second.arrayBuffer();
    });

    it("does NOT cache plain GET at-tail reads", async () => {
      const streamId = uniqueStreamId("cache-tail");

      // Small data — fits in one chunk, so the read IS at-tail
      await client.createStream(streamId, "some-data", "text/plain");

      const url = client.streamUrl(streamId, { offset: ZERO_OFFSET });

      const first = await fetch(url);
      expect(first.status).toBe(200);
      expect(first.headers.get("Stream-Up-To-Date")).toBe("true");
      expect(first.headers.get("X-Cache")).toBe("MISS");
      await first.arrayBuffer();

      await delay(CACHE_SETTLE_MS);

      // At-tail plain GET is NOT cached — breaks read-after-write
      const second = await fetch(url);
      expect(second.status).toBe(200);
      expect(second.headers.get("X-Cache")).toBe("MISS");
      await second.arrayBuffer();
    });

    it("caches long-poll at-tail 200 responses", async () => {
      const streamId = uniqueStreamId("cache-lp-tail");

      await client.createStream(streamId, "data", "text/plain");

      const url = client.streamUrl(streamId, {
        offset: ZERO_OFFSET,
        live: "long-poll",
        cursor: "init",
      });

      const first = await fetch(url);
      expect(first.status).toBe(200);
      expect(first.headers.get("X-Cache")).toBe("MISS");
      expect(first.headers.get("Stream-Up-To-Date")).toBe("true");
      await first.arrayBuffer();

      const second = await waitForCacheHit(url);
      expect(second.status).toBe(200);
      expect(second.headers.get("X-Cache")).toBe("HIT");
      expect(second.headers.get("Stream-Up-To-Date")).toBe("true");
      await second.arrayBuffer();
    });

    it("does NOT cache long-poll 204 timeout responses", async () => {
      const streamId = uniqueStreamId("cache-lp-204");

      // Create stream with no data — long-poll will timeout
      await client.createStream(streamId, "", "text/plain");

      const url = client.streamUrl(streamId, {
        offset: ZERO_OFFSET,
        live: "long-poll",
        cursor: "init",
      });

      const first = await fetch(url);
      expect(first.status).toBe(204);
      // 204 is not stored — no X-Cache header or MISS
      const cache1 = first.headers.get("X-Cache");
      expect(cache1 === null || cache1 === "MISS").toBe(true);

      const second = await fetch(url);
      expect(second.status).toBe(204);
      const cache2 = second.headers.get("X-Cache");
      expect(cache2 === null || cache2 === "MISS").toBe(true);
    });

    it("does NOT cache offset=now responses", async () => {
      const streamId = uniqueStreamId("cache-offset-now");

      await client.createStream(streamId, "data", "text/plain");

      const url = client.streamUrl(streamId, { offset: "now" });

      const first = await fetch(url);
      expect(first.status).toBe(200);
      expect(first.headers.get("Cache-Control")).toContain("no-store");
      expect(first.headers.get("X-Cache")).toBe("MISS");
      await first.arrayBuffer();

      const second = await fetch(url);
      expect(second.status).toBe(200);
      expect(second.headers.get("X-Cache")).toBe("MISS");
      await second.arrayBuffer();
    });

    it("does NOT cache error responses (404)", async () => {
      const streamId = uniqueStreamId("cache-404");
      const url = client.streamUrl(streamId, { offset: ZERO_OFFSET });

      const first = await fetch(url);
      expect(first.status).toBe(404);
      expect(first.headers.get("X-Cache")).toBe("MISS");
      await first.arrayBuffer();

      const second = await fetch(url);
      expect(second.status).toBe(404);
      expect(second.headers.get("X-Cache")).toBe("MISS");
      await second.arrayBuffer();
    });

    it("does NOT cache expired TTL stream responses", async () => {
      const streamId = uniqueStreamId("cache-ttl-exp");
      const streamUrl = client.streamUrl(streamId);

      const create = await fetch(streamUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          "Stream-TTL": "1",
        },
        body: "data",
      });
      expect([200, 201]).toContain(create.status);

      // Wait for TTL to expire
      await delay(2500);

      const url = client.streamUrl(streamId, { offset: ZERO_OFFSET });

      const first = await fetch(url);
      const firstCache = first.headers.get("X-Cache");
      expect(firstCache === "MISS" || firstCache === null).toBe(true);
      await first.arrayBuffer();

      const second = await fetch(url);
      const secondCache = second.headers.get("X-Cache");
      expect(secondCache === "MISS" || secondCache === null).toBe(true);
      await second.arrayBuffer();
    });

    it("does NOT cache SSE responses", async () => {
      const streamId = uniqueStreamId("cache-sse");

      await client.createStream(streamId, "sse-data", "text/plain");

      const url = client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" });

      const res = await fetch(url);
      expect(res.status).toBe(200);
      // SSE is non-cacheable — no X-Cache header emitted
      expect(res.headers.get("X-Cache")).toBeNull();
      expect(res.headers.get("Content-Type")).toContain("text/event-stream");
      // Cancel the streaming response
      await res.body?.cancel();
    });

    it("does NOT cache closed stream plain GET at-tail reads", async () => {
      const streamId = uniqueStreamId("cache-closed-tail");

      await client.createStream(streamId, "closed-data", "text/plain");

      // Close the stream
      const close = await fetch(client.streamUrl(streamId), {
        method: "POST",
        headers: { "Stream-Closed": "true" },
      });
      expect([200, 204]).toContain(close.status);

      const url = client.streamUrl(streamId, { offset: ZERO_OFFSET });

      const first = await fetch(url);
      expect(first.status).toBe(200);
      expect(first.headers.get("Stream-Up-To-Date")).toBe("true");
      expect(first.headers.get("X-Cache")).toBe("MISS");
      await first.arrayBuffer();

      await delay(CACHE_SETTLE_MS);

      // Even though the stream is closed (immutable), plain GET at-tail
      // is still NOT cached to preserve consistency with the general rule.
      const second = await fetch(url);
      expect(second.status).toBe(200);
      expect(second.headers.get("X-Cache")).toBe("MISS");
      await second.arrayBuffer();
    });
  });

  // ================================================================
  // Cache lookup and collapsing
  // ================================================================
  describe("cache lookup and collapsing", () => {
    it("serves identical body from cache hit", async () => {
      const streamId = uniqueStreamId("cache-body");

      await client.createStream(streamId, "known-data-payload", "text/plain");

      // Use long-poll — long-poll at-tail IS cached (cursor rotation prevents stale loops)
      const url = client.streamUrl(streamId, {
        offset: ZERO_OFFSET,
        live: "long-poll",
        cursor: "init",
      });

      const first = await fetch(url);
      expect(first.status).toBe(200);
      expect(first.headers.get("X-Cache")).toBe("MISS");
      const body1 = await first.text();

      const second = await waitForCacheHit(url);
      expect(second.status).toBe(200);
      expect(second.headers.get("X-Cache")).toBe("HIT");
      const body2 = await second.text();

      expect(body1).toBe(body2);
    });

    it("ETag revalidation returns 304 from cache", async () => {
      const streamId = uniqueStreamId("cache-etag");

      await client.createStream(streamId, "etag-data", "text/plain");

      // Use long-poll — long-poll at-tail IS cached
      const url = client.streamUrl(streamId, {
        offset: ZERO_OFFSET,
        live: "long-poll",
        cursor: "init",
      });

      // First GET — cache miss, captures ETag
      const first = await fetch(url);
      expect(first.status).toBe(200);
      expect(first.headers.get("X-Cache")).toBe("MISS");
      const etag = first.headers.get("ETag");
      expect(etag).toBeTruthy();
      await first.arrayBuffer();

      // Second GET — cache hit
      const second = await waitForCacheHit(url);
      expect(second.status).toBe(200);
      expect(second.headers.get("X-Cache")).toBe("HIT");
      await second.arrayBuffer();

      // Third GET with If-None-Match — should get 304 from cache.
      // Explicitly set Cache-Control to prevent undici from adding
      // "no-cache" automatically on conditional requests.
      const third = await fetch(url, {
        headers: { "If-None-Match": etag!, "Cache-Control": "max-age=0" },
      });
      expect(third.status).toBe(304);
      expect(third.headers.get("X-Cache")).toBe("HIT");
    });

    it("long-poll cursor rotation creates new cache keys", async () => {
      const streamId = uniqueStreamId("cache-cursor-rot");

      await client.createStream(streamId, "cursor-data", "text/plain");

      const url1 = client.streamUrl(streamId, {
        offset: ZERO_OFFSET,
        live: "long-poll",
        cursor: "aaa",
      });

      const first = await fetch(url1);
      expect(first.status).toBe(200);
      expect(first.headers.get("X-Cache")).toBe("MISS");
      const nextCursor = first.headers.get("Stream-Cursor");
      const nextOffset = first.headers.get("Stream-Next-Offset");
      expect(nextCursor).toBeTruthy();
      expect(nextOffset).toBeTruthy();
      await first.arrayBuffer();

      // Use the new cursor and offset — different URL, new cache key
      const url2 = client.streamUrl(streamId, {
        offset: nextOffset!,
        live: "long-poll",
        cursor: nextCursor!,
      });

      const second = await fetch(url2);
      expect(second.headers.get("X-Cache")).toBe("MISS");
      await second.arrayBuffer();
    });
  });

  // ================================================================
  // Read-after-write consistency
  // ================================================================
  describe("read-after-write consistency", () => {
    it("plain GET at tail returns new data after append, not stale cache", async () => {
      const streamId = uniqueStreamId("cache-raw");

      await client.createStream(streamId, "initial", "text/plain");

      const url = client.streamUrl(streamId, { offset: ZERO_OFFSET });

      // First read — gets "initial", at-tail, MISS
      const first = await fetch(url);
      expect(first.status).toBe(200);
      expect(first.headers.get("Stream-Up-To-Date")).toBe("true");
      expect(first.headers.get("X-Cache")).toBe("MISS");
      const body1 = await first.text();
      expect(body1).toContain("initial");
      const nextOffset = first.headers.get("Stream-Next-Offset");
      expect(nextOffset).toBeTruthy();

      // Append new data
      await client.appendStream(streamId, "appended", "text/plain");

      // Read from the next offset — should see the NEW data, not stale
      const readUrl = client.streamUrl(streamId, { offset: nextOffset! });
      const second = await fetch(readUrl);
      expect(second.status).toBe(200);
      const body2 = await second.text();
      expect(body2).toContain("appended");
    });
  });

  // ================================================================
  // Mid-stream long-poll caching
  // ================================================================
  describe("mid-stream long-poll caching", () => {
    it("caches mid-stream long-poll reads (not just at-tail)", async () => {
      const streamId = uniqueStreamId("cache-lp-mid");

      // Multiple appends to create a stream larger than maxChunkBytes
      const chunk = "b".repeat(100 * 1024); // 100KB per append
      await client.createStream(streamId, chunk, "text/plain");
      await client.appendStream(streamId, chunk, "text/plain");
      await client.appendStream(streamId, chunk, "text/plain");

      const url = client.streamUrl(streamId, {
        offset: ZERO_OFFSET,
        live: "long-poll",
        cursor: "init",
      });

      const first = await fetch(url);
      expect(first.status).toBe(200);
      // Mid-stream: NOT up-to-date (more data available)
      expect(first.headers.get("Stream-Up-To-Date")).not.toBe("true");
      expect(first.headers.get("X-Cache")).toBe("MISS");
      await first.arrayBuffer();

      const second = await waitForCacheHit(url);
      expect(second.status).toBe(200);
      expect(second.headers.get("X-Cache")).toBe("HIT");
      await second.arrayBuffer();
    });
  });

  // ================================================================
  // Cache bypass
  // ================================================================
  describe("cache bypass", () => {
    it("client Cache-Control: no-cache skips lookup but cache stays populated", async () => {
      const streamId = uniqueStreamId("cache-bypass-nc");

      await client.createStream(streamId, "bypass-data", "text/plain");

      // Use long-poll — long-poll at-tail IS cached
      const url = client.streamUrl(streamId, {
        offset: ZERO_OFFSET,
        live: "long-poll",
        cursor: "init",
      });

      // First GET — cache miss, populates cache
      const first = await fetch(url);
      expect(first.status).toBe(200);
      expect(first.headers.get("X-Cache")).toBe("MISS");
      await first.arrayBuffer();

      // Second GET — cache hit
      const second = await waitForCacheHit(url);
      expect(second.status).toBe(200);
      expect(second.headers.get("X-Cache")).toBe("HIT");
      await second.arrayBuffer();

      // Third GET with no-cache — bypasses cache lookup
      const third = await fetch(url, {
        headers: { "Cache-Control": "no-cache" },
      });
      expect(third.status).toBe(200);
      expect(third.headers.get("X-Cache")).toBe("BYPASS");
      await third.arrayBuffer();

      // Fourth GET without special headers — cache still populated
      const fourth = await waitForCacheHit(url);
      expect(fourth.status).toBe(200);
      expect(fourth.headers.get("X-Cache")).toBe("HIT");
      await fourth.arrayBuffer();
    });

    it("debug requests (X-Debug-Coalesce) are never cached", async () => {
      const streamId = uniqueStreamId("cache-debug");

      await client.createStream(streamId, "debug-data", "text/plain");

      const url = client.streamUrl(streamId, { offset: ZERO_OFFSET });

      // Debug request — not cacheable, no X-Cache header
      const debug = await fetch(url, {
        headers: { "X-Debug-Coalesce": "1" },
      });
      expect(debug.status).toBe(200);
      expect(debug.headers.get("X-Cache")).toBeNull();
      await debug.arrayBuffer();

      // Normal GET — separate from debug, cache miss
      const normal = await fetch(url);
      expect(normal.status).toBe(200);
      expect(normal.headers.get("X-Cache")).toBe("MISS");
      await normal.arrayBuffer();
    });
  });

  // ================================================================
  // Non-cacheable request types
  // ================================================================
  describe("non-cacheable request types", () => {
    it("HEAD requests have no X-Cache header", async () => {
      const streamId = uniqueStreamId("cache-head");

      await client.createStream(streamId, "head-data", "text/plain");

      const url = client.streamUrl(streamId);

      const head = await fetch(url, { method: "HEAD" });
      expect(head.headers.get("X-Cache")).toBeNull();
    });

    it("POST/PUT/DELETE have no X-Cache header", async () => {
      const streamId = uniqueStreamId("cache-mut");
      const url = client.streamUrl(streamId);

      // PUT to create
      const put = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "create",
      });
      expect([200, 201]).toContain(put.status);
      expect(put.headers.get("X-Cache")).toBeNull();

      // POST to append
      const post = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "append",
      });
      expect([200, 204]).toContain(post.status);
      expect(post.headers.get("X-Cache")).toBeNull();

      // DELETE
      const del = await fetch(url, { method: "DELETE" });
      expect(del.headers.get("X-Cache")).toBeNull();
    });
  });

  // ================================================================
  // Cache-Control headers from DO
  // ================================================================
  describe("Cache-Control headers from DO", () => {
    it("long-poll 200 has max-age=20", async () => {
      const streamId = uniqueStreamId("cache-cc-lp");

      await client.createStream(streamId, "lp-data", "text/plain");

      const url = client.streamUrl(streamId, {
        offset: ZERO_OFFSET,
        live: "long-poll",
        cursor: "init",
      });

      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=20");
      await res.arrayBuffer();
    });

    it("plain GET has max-age=60 with stale-while-revalidate", async () => {
      const streamId = uniqueStreamId("cache-cc-get");

      await client.createStream(streamId, "get-data", "text/plain");

      const url = client.streamUrl(streamId, { offset: ZERO_OFFSET });

      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe(
        "public, max-age=60, stale-while-revalidate=300",
      );
      await res.arrayBuffer();
    });

    it("long-poll 204 timeout has no-store", async () => {
      const streamId = uniqueStreamId("cache-cc-lp204");

      // Create empty stream — long-poll will timeout with 204
      await client.createStream(streamId, "", "text/plain");

      const url = client.streamUrl(streamId, {
        offset: ZERO_OFFSET,
        live: "long-poll",
        cursor: "init",
      });

      const res = await fetch(url);
      expect(res.status).toBe(204);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("HEAD requests return Cache-Control: no-store", async () => {
      const streamId = uniqueStreamId("cache-cc-head");

      await client.createStream(streamId, "head-data", "text/plain");

      const url = client.streamUrl(streamId);

      const res = await fetch(url, { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("expired TTL stream returns 404 (no cacheable response)", async () => {
      const streamId = uniqueStreamId("cache-cc-ttl-exp");
      const streamUrl = client.streamUrl(streamId);

      const create = await fetch(streamUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          "Stream-TTL": "10",
        },
        body: "data",
      });
      expect([200, 201]).toContain(create.status);

      // Read BEFORE expiry — should have a public max-age capped to remaining TTL
      const readUrl = client.streamUrl(streamId, { offset: ZERO_OFFSET });
      const before = await fetch(readUrl);
      expect(before.status).toBe(200);
      const ccBefore = before.headers.get("Cache-Control") ?? "";
      expect(ccBefore).toContain("public");
      expect(ccBefore).toContain("max-age=");
      await before.arrayBuffer();

      // Wait for TTL to expire
      await delay(11_000);

      // After expiry — 404, not cacheable (errors are never cached)
      const after = await fetch(readUrl);
      expect(after.status).toBe(404);
      await after.arrayBuffer();
    });

    it("TTL stream has max-age capped to remaining TTL", async () => {
      const streamId = uniqueStreamId("cache-cc-ttl");
      const url = client.streamUrl(streamId);

      const create = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          "Stream-TTL": "10",
        },
        body: "ttl-data",
      });
      expect([200, 201]).toContain(create.status);

      const readUrl = client.streamUrl(streamId, { offset: ZERO_OFFSET });

      const res = await fetch(readUrl);
      expect(res.status).toBe(200);
      const cc = res.headers.get("Cache-Control") ?? "";
      expect(cc).toContain("public");
      const match = cc.match(/max-age=(\d+)/);
      expect(match).toBeTruthy();
      const maxAge = Number(match![1]);
      expect(maxAge).toBeLessThanOrEqual(10);
      expect(maxAge).toBeGreaterThan(0);
      await res.arrayBuffer();
    });
  });

  // ================================================================
  // ETags vary with closure status
  // ================================================================
  describe("ETags", () => {
    it("ETag changes when stream closes (varies with closure status)", async () => {
      const streamId = uniqueStreamId("cache-etag-close");

      await client.createStream(streamId, "etag-close-data", "text/plain");

      const url = client.streamUrl(streamId, { offset: ZERO_OFFSET });

      // Read while stream is open
      const openRead = await fetch(url);
      expect(openRead.status).toBe(200);
      const openEtag = openRead.headers.get("ETag");
      expect(openEtag).toBeTruthy();
      expect(openRead.headers.get("Stream-Closed")).toBeNull();
      await openRead.arrayBuffer();

      // Close the stream
      const close = await fetch(client.streamUrl(streamId), {
        method: "POST",
        headers: { "Stream-Closed": "true" },
      });
      expect([200, 204]).toContain(close.status);

      // Read after close — same offset range, but ETag must differ
      const closedRead = await fetch(url);
      expect(closedRead.status).toBe(200);
      const closedEtag = closedRead.headers.get("ETag");
      expect(closedEtag).toBeTruthy();
      expect(closedRead.headers.get("Stream-Closed")).toBe("true");
      await closedRead.arrayBuffer();

      // ETags differ because closure status is included
      expect(closedEtag).not.toBe(openEtag);
    });
  });

  // ================================================================
  // SSE reconnect interval for edge collapsing
  // ================================================================
  describe("SSE lifecycle", () => {
    // Skipped: The DO's SSE close timer (SSE_RECONNECT_MS = 55s) does not
    // reliably fire through the SSE-via-WebSocket bridge in miniflare/local
    // mode. The stream never closes within the expected window, causing the
    // safety timeout to fire instead. Enable this test when running against
    // a deployed worker or once miniflare properly supports DO setTimeout
    // for WebSocket-bridged SSE.
    it.skip("SSE connections close after approximately 55 seconds to enable edge collapsing", async () => {
      const streamId = uniqueStreamId("cache-sse-timer");

      await client.createStream(streamId, "sse-timer-data", "text/plain");

      const url = client.streamUrl(streamId, {
        offset: ZERO_OFFSET,
        live: "sse",
      });

      const start = Date.now();
      const res = await fetch(url);
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Read until the stream closes (SSE_RECONNECT_MS = 55_000)
      try {
        while (true) {
          const result = await Promise.race([
            reader.read(),
            new Promise<{ done: true; value: undefined }>((resolve) =>
              setTimeout(() => resolve({ done: true, value: undefined }), 80_000),
            ),
          ]);
          if (result.done) break;
          if (result.value) {
            buffer += decoder.decode(result.value, { stream: true });
          }
        }
      } catch {
        // Stream closed
      }

      const elapsed = Date.now() - start;
      // SSE_RECONNECT_MS is 55_000. Allow a generous window:
      // - At least 50s (not closing too early)
      // - At most 75s (accounting for WS bridge overhead)
      expect(elapsed).toBeGreaterThan(50_000);
      expect(elapsed).toBeLessThan(75_000);
      // Verify we actually received SSE events
      expect(buffer).toContain("event:");
    }, 85_000);

    it("SSE responses have no X-Cache header (non-cacheable)", async () => {
      const streamId = uniqueStreamId("cache-sse-nocache");

      await client.createStream(streamId, "sse-no-cache", "text/plain");

      const url = client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" });

      const first = await fetch(url);
      expect(first.status).toBe(200);
      expect(first.headers.get("X-Cache")).toBeNull();

      await delay(CACHE_SETTLE_MS);

      // Second SSE request — still no X-Cache, never cached
      const second = await fetch(url);
      expect(second.status).toBe(200);
      expect(second.headers.get("X-Cache")).toBeNull();

      await first.body?.cancel();
      await second.body?.cancel();
    });
  });
});
