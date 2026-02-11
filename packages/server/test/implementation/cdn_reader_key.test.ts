import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../src/http/v1/streams/shared/offsets";
import { buildStreamUrl, delay, uniqueStreamId, waitForCacheHit } from "./helpers";
import { startWorker, type WorkerHandle } from "./worker_harness";

describe("CDN reader key", () => {
  let handle: WorkerHandle;
  let baseUrl: string;

  // Start an auth-enabled worker so reader keys are generated
  beforeAll(async () => {
    handle = await startWorker({ configFile: "wrangler.test-auth.toml" });
    baseUrl = handle.baseUrl;
  });

  afterAll(async () => {
    await handle.stop();
  });

  function url(streamId: string, params?: Record<string, string>): string {
    return buildStreamUrl(baseUrl, streamId, params);
  }

  it("PUT 201 returns Stream-Reader-Key for non-public streams", async () => {
    const streamId = uniqueStreamId("rk-put");

    const res = await fetch(url(streamId), {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "hello",
    });

    expect(res.status).toBe(201);
    const rk = res.headers.get("Stream-Reader-Key");
    expect(rk).toBeTruthy();
    expect(rk).toMatch(/^rk_[a-f0-9]{32}$/);
    await res.arrayBuffer();
  });

  it("PUT 201 does NOT return Stream-Reader-Key for public streams", async () => {
    const streamId = uniqueStreamId("rk-pub");

    const res = await fetch(url(streamId, { public: "true" }), {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "hello",
    });

    expect(res.status).toBe(201);
    expect(res.headers.get("Stream-Reader-Key")).toBeNull();
    await res.arrayBuffer();
  });

  it("HEAD returns Stream-Reader-Key for non-public streams", async () => {
    const streamId = uniqueStreamId("rk-head");

    // Create stream (non-public)
    const create = await fetch(url(streamId), {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "data",
    });
    expect(create.status).toBe(201);
    const rkFromPut = create.headers.get("Stream-Reader-Key");
    expect(rkFromPut).toBeTruthy();
    await create.arrayBuffer();

    // KV write is in ctx.waitUntil — give it a moment
    await delay(200);

    // HEAD should return the same reader key
    const head = await fetch(url(streamId), { method: "HEAD" });
    expect(head.ok).toBe(true);
    expect(head.headers.get("Stream-Reader-Key")).toBe(rkFromPut);
  });

  it("HEAD does NOT return Stream-Reader-Key for public streams", async () => {
    const streamId = uniqueStreamId("rk-head-pub");

    const create = await fetch(url(streamId, { public: "true" }), {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "data",
    });
    expect(create.status).toBe(201);
    await create.arrayBuffer();

    await delay(200);

    const head = await fetch(url(streamId), { method: "HEAD" });
    expect(head.ok).toBe(true);
    expect(head.headers.get("Stream-Reader-Key")).toBeNull();
  });

  it("GET with ?rk is cached normally (mid-stream read)", async () => {
    const streamId = uniqueStreamId("rk-cache-hit");

    // Create stream with enough data for a mid-stream read
    const chunk = "a".repeat(100 * 1024);
    const create = await fetch(url(streamId), {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: chunk,
    });
    expect(create.status).toBe(201);
    const rk = create.headers.get("Stream-Reader-Key")!;
    expect(rk).toBeTruthy();
    await create.arrayBuffer();

    // Append more data so read at ZERO_OFFSET is mid-stream
    for (let i = 0; i < 2; i++) {
      const append = await fetch(url(streamId), {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: chunk,
      });
      expect([200, 204]).toContain(append.status);
      await append.arrayBuffer();
    }

    // Read with ?rk — first is MISS
    const readUrl = url(streamId, { offset: ZERO_OFFSET, rk });
    const first = await fetch(readUrl);
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Cache")).toBe("MISS");
    await first.arrayBuffer();

    // Second read should be HIT
    const second = await waitForCacheHit(readUrl);
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Cache")).toBe("HIT");
    await second.arrayBuffer();
  });

  it("GET without ?rk on stream with reader key is NOT cached", async () => {
    const streamId = uniqueStreamId("rk-no-cache");

    // Create stream with enough data for a mid-stream read
    const chunk = "a".repeat(100 * 1024);
    const create = await fetch(url(streamId), {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: chunk,
    });
    expect(create.status).toBe(201);
    expect(create.headers.get("Stream-Reader-Key")).toBeTruthy();
    await create.arrayBuffer();

    // Append more data
    for (let i = 0; i < 2; i++) {
      const append = await fetch(url(streamId), {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: chunk,
      });
      expect([200, 204]).toContain(append.status);
      await append.arrayBuffer();
    }

    await delay(200);

    // Read WITHOUT ?rk — first is MISS (response is served, just not cached)
    const readUrl = url(streamId, { offset: ZERO_OFFSET });
    const first = await fetch(readUrl);
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Cache")).toBe("MISS");
    await first.arrayBuffer();

    await delay(100);

    // Second read also MISS — the response was never cached
    const second = await fetch(readUrl);
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Cache")).toBe("MISS");
    await second.arrayBuffer();
  });

  it("public streams are cached normally without ?rk", async () => {
    const streamId = uniqueStreamId("rk-pub-cache");

    // Create public stream with enough data for mid-stream read
    const chunk = "a".repeat(100 * 1024);
    const create = await fetch(url(streamId, { public: "true" }), {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: chunk,
    });
    expect(create.status).toBe(201);
    expect(create.headers.get("Stream-Reader-Key")).toBeNull();
    await create.arrayBuffer();

    // Append more data so the read is mid-stream
    for (let i = 0; i < 2; i++) {
      const append = await fetch(url(streamId), {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: chunk,
      });
      expect([200, 204]).toContain(append.status);
      await append.arrayBuffer();
    }

    // Read without ?rk — should cache normally
    const readUrl = url(streamId, { offset: ZERO_OFFSET });
    const first = await fetch(readUrl);
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Cache")).toBe("MISS");
    await first.arrayBuffer();

    const second = await waitForCacheHit(readUrl);
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Cache")).toBe("HIT");
    await second.arrayBuffer();
  });

  it("rotateReaderKey returns a new key", async () => {
    const streamId = uniqueStreamId("rk-rotate");

    // Create stream
    const create = await fetch(url(streamId), {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "data",
    });
    expect(create.status).toBe(201);
    const originalRk = create.headers.get("Stream-Reader-Key");
    expect(originalRk).toBeTruthy();
    await create.arrayBuffer();

    await delay(200);

    // Rotate via debug action
    const rotate = await fetch(url(streamId), {
      method: "POST",
      headers: { "X-Debug-Action": "rotate-reader-key" },
    });
    expect(rotate.status).toBe(200);
    const body = await rotate.json() as { readerKey: string };
    expect(body.readerKey).toBeTruthy();
    expect(body.readerKey).not.toBe(originalRk);
    expect(body.readerKey).toMatch(/^rk_[a-f0-9]{32}$/);

    // HEAD should return the new key
    const head = await fetch(url(streamId), { method: "HEAD" });
    expect(head.ok).toBe(true);
    expect(head.headers.get("Stream-Reader-Key")).toBe(body.readerKey);
  });
});
