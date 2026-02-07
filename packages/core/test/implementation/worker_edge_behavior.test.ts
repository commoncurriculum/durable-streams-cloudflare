import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZERO_OFFSET, decodeOffsetParts, encodeOffset } from "../../src/protocol/offsets";
import { startWorker, type WorkerHandle } from "./worker_harness";
import { uniqueStreamId } from "./helpers";

async function seedStream(url: string): Promise<string> {
  const create = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "",
  });
  expect([200, 201]).toContain(create.status);

  for (let i = 0; i < 1200; i += 1) {
    const append = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x",
    });
    expect([200, 204]).toContain(append.status);
  }

  const compact = await fetch(url, {
    method: "POST",
    headers: { "X-Debug-Action": "compact-retain" },
  });
  expect(compact.status).toBe(204);

  const appendHot = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "y",
  });
  expect([200, 204]).toContain(appendHot.status);
  const nextOffset = appendHot.headers.get("Stream-Next-Offset");
  expect(nextOffset).toBeTruthy();
  const decoded = nextOffset ? decodeOffsetParts(nextOffset) : null;
  expect(decoded).not.toBeNull();

  return encodeOffset(Math.max(0, decoded!.byteOffset - 1), decoded!.readSeq);
}

function parseMaxAge(cacheControl: string): number | null {
  const match = cacheControl.match(/max-age=(\d+)/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function hasEdgeCacheTiming(
  header: string | null,
  descriptor: "hit" | "miss" | null = null,
): boolean {
  if (!header) return false;
  if (!descriptor) return header.includes("edge.cache");
  return header.includes(`edge.cache`) && header.includes(`desc="${descriptor}"`);
}

describe("worker edge behavior", () => {
  describe("with auth enabled", () => {
    let handle: WorkerHandle;

    beforeAll(async () => {
      handle = await startWorker({ useProductionAuth: true });
    });

    afterAll(async () => {
      await handle.stop();
    });

    it("rejects requests without a valid auth token", async () => {
      const streamId = uniqueStreamId("auth");
      const url = `${handle.baseUrl}/v1/stream/${streamId}`;

      const unauthorized = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "hello",
      });
      expect(unauthorized.status).toBe(401);
    });
  });

  describe("caching behavior", () => {
    let handle: WorkerHandle;

    beforeAll(async () => {
      handle = await startWorker();
    });

    afterAll(async () => {
      await handle.stop();
    });

    it("uses no-store for open streams", async () => {
      const streamId = uniqueStreamId("cache-open");
      const url = `${handle.baseUrl}/v1/stream/${streamId}`;

      const hotOffset = await seedStream(url);

      const hotRead = await fetch(`${url}?offset=${hotOffset}`);
      expect(hotRead.status).toBe(200);
      const hotCache = hotRead.headers.get("Cache-Control") ?? "";
      expect(hotCache).toBe("no-store");
    });

    it("uses public caching for closed streams", async () => {
      const streamId = uniqueStreamId("cache-closed");
      const url = `${handle.baseUrl}/v1/stream/${streamId}`;

      const hotOffset = await seedStream(url);

      // Close the stream — closed streams are immutable and safe to cache
      const close = await fetch(url, {
        method: "POST",
        headers: { "Stream-Closed": "true" },
      });
      expect([200, 204]).toContain(close.status);

      const coldRead = await fetch(`${url}?offset=${ZERO_OFFSET}`);
      expect(coldRead.status).toBe(200);
      const coldCache = coldRead.headers.get("Cache-Control") ?? "";
      expect(coldCache).toContain("public");
      const coldMaxAge = parseMaxAge(coldCache);
      expect(coldMaxAge).not.toBeNull();
      expect(coldMaxAge!).toBeGreaterThanOrEqual(60);

      const hotRead = await fetch(`${url}?offset=${hotOffset}`);
      expect(hotRead.status).toBe(200);
      const hotCache = hotRead.headers.get("Cache-Control") ?? "";
      expect(hotCache).toContain("public");
      const hotMaxAge = parseMaxAge(hotCache);
      expect(hotMaxAge).not.toBeNull();
      expect(hotMaxAge!).toBeGreaterThan(0);
    });

    it("records edge cache hits for closed streams", async () => {
      const streamId = uniqueStreamId("cache-hit");
      const url = `${handle.baseUrl}/v1/stream/${streamId}`;

      const hotOffset = await seedStream(url);

      // Close the stream so responses are CDN-cacheable
      const close = await fetch(url, {
        method: "POST",
        headers: { "Stream-Closed": "true" },
      });
      expect([200, 204]).toContain(close.status);

      const warm = await fetch(`${url}?offset=${hotOffset}`);
      expect(warm.status).toBe(200);
      await warm.arrayBuffer();

      const cached = await fetch(`${url}?offset=${hotOffset}`, {
        headers: { "X-Debug-Timing": "1" },
      });
      expect(cached.status).toBe(200);
      const timing = cached.headers.get("Server-Timing");
      expect(hasEdgeCacheTiming(timing, "hit")).toBe(true);
    });

    it("bypasses edge cache when If-None-Match is set", async () => {
      const streamId = uniqueStreamId("cache-bypass");
      const url = `${handle.baseUrl}/v1/stream/${streamId}`;

      const hotOffset = await seedStream(url);

      const first = await fetch(`${url}?offset=${hotOffset}`);
      expect(first.status).toBe(200);
      const firstEtag = first.headers.get("ETag");
      await first.arrayBuffer();
      expect(firstEtag).toBeTruthy();

      const append = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "z",
      });
      expect([200, 204]).toContain(append.status);

      const second = await fetch(`${url}?offset=${hotOffset}`, {
        headers: {
          "If-None-Match": firstEtag ?? "",
          "X-Debug-Timing": "1",
        },
      });
      expect(second.status).toBe(200);
      const secondEtag = second.headers.get("ETag");
      expect(secondEtag).not.toBe(firstEtag);
      const timing = second.headers.get("Server-Timing");
      expect(hasEdgeCacheTiming(timing)).toBe(false);
    });

    it("emits Server-Timing when debug is enabled", async () => {
      const streamId = uniqueStreamId("timing");
      const url = `${handle.baseUrl}/v1/stream/${streamId}`;

      const create = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain", "X-Debug-Timing": "1" },
        body: "hello",
      });
      expect([200, 201]).toContain(create.status);
      const timing = create.headers.get("Server-Timing");
      expect(timing).toBeTruthy();
      expect(timing ?? "").toContain("edge.origin");
    });
  });
});
