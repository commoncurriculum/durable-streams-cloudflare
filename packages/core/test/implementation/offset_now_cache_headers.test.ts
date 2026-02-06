import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorker, type WorkerHandle } from "./worker_harness";
import { delay, uniqueStreamId } from "./helpers";

describe("offset=now cache headers", () => {
  describe("with CACHE_MODE=shared", () => {
    let handle: WorkerHandle;

    beforeAll(async () => {
      handle = await startWorker({ vars: { CACHE_MODE: "shared" } });
    });

    afterAll(async () => {
      await handle.stop();
    });

    it("forces no-store in shared mode for catch-up and long-poll", async () => {
      const streamId = uniqueStreamId("offset-now-shared");
      const streamUrl = `${handle.baseUrl}/v1/stream/${streamId}`;

      const create = await fetch(streamUrl, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
      });
      expect([200, 201]).toContain(create.status);

      const catchup = await fetch(`${streamUrl}?offset=now`);
      expect(catchup.status).toBe(200);
      const catchupCache = catchup.headers.get("Cache-Control") ?? "";
      expect(catchupCache).toContain("no-store");

      const longPollPromise = fetch(`${streamUrl}?live=long-poll&offset=now`);
      await delay(50);
      await fetch(streamUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "hello",
      });

      const longPoll = await longPollPromise;
      expect(longPoll.status).toBe(200);
      const longPollCache = longPoll.headers.get("Cache-Control") ?? "";
      expect(longPollCache).toContain("no-store");
    });
  });

  describe("with default (private) mode", () => {
    let handle: WorkerHandle;

    beforeAll(async () => {
      handle = await startWorker();
    });

    afterAll(async () => {
      await handle.stop();
    });

    it("uses private no-store for offset=now in private mode", async () => {
      const streamId = uniqueStreamId("offset-now-private");
      const streamUrl = `${handle.baseUrl}/v1/stream/${streamId}`;

      const create = await fetch(streamUrl, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
      });
      expect([200, 201]).toContain(create.status);

      const catchup = await fetch(`${streamUrl}?offset=now`);
      expect(catchup.status).toBe(200);
      const catchupCache = catchup.headers.get("Cache-Control") ?? "";
      expect(catchupCache).toContain("private");
      expect(catchupCache).toContain("no-store");

      const longPollPromise = fetch(`${streamUrl}?live=long-poll&offset=now`);
      await delay(50);
      await fetch(streamUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "hello",
      });

      const longPoll = await longPollPromise;
      expect(longPoll.status).toBe(200);
      const longPollCache = longPoll.headers.get("Cache-Control") ?? "";
      expect(longPollCache).toContain("private");
      expect(longPollCache).toContain("no-store");
    });
  });
});
