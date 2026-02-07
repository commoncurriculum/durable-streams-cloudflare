import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../src/protocol/offsets";
import { createClient, delay, uniqueStreamId } from "./helpers";

// Small delay to allow ctx.waitUntil(cache.put()) to complete before
// the next request. The cache store is fire-and-forget via waitUntil,
// so without a brief pause the second request may arrive before the
// entry is written.
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

      await delay(CACHE_SETTLE_MS);

      const second = await fetch(url);
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

      await delay(CACHE_SETTLE_MS);

      const second = await fetch(url);
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

      await delay(CACHE_SETTLE_MS);

      const second = await fetch(url);
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

      await delay(CACHE_SETTLE_MS);

      // Second GET — cache hit
      const second = await fetch(url);
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

      await delay(CACHE_SETTLE_MS);

      // Second GET — cache hit
      const second = await fetch(url);
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

      await delay(CACHE_SETTLE_MS);

      // Fourth GET without special headers — cache still populated
      const fourth = await fetch(url);
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
});
