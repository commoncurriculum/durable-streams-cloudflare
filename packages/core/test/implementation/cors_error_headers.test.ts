import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorker, type WorkerHandle } from "./worker_harness";
import { uniqueStreamId } from "./helpers";

function expectCors(headers: Headers): void {
  expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(headers.get("Access-Control-Allow-Methods")).toContain("GET");
  expect(headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
}

describe("CORS + error cache headers", () => {
  describe("with AUTH_TOKEN", () => {
    let handle: WorkerHandle;

    beforeAll(async () => {
      handle = await startWorker({ vars: { AUTH_TOKEN: "test-token" } });
    });

    afterAll(async () => {
      await handle.stop();
    });

    it("includes CORS and no-store on 401 responses", async () => {
      const streamId = uniqueStreamId("cors-401");
      const url = `${handle.baseUrl}/v1/stream/${streamId}`;

      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "hello",
      });
      expect(response.status).toBe(401);
      expectCors(response.headers);
      const cacheControl = response.headers.get("Cache-Control") ?? "";
      expect(cacheControl).toContain("no-store");
    });
  });

  describe("with default config", () => {
    let handle: WorkerHandle;

    beforeAll(async () => {
      handle = await startWorker();
    });

    afterAll(async () => {
      await handle.stop();
    });

    it("includes CORS and no-store on 404 responses", async () => {
      const streamId = uniqueStreamId("cors-404");
      const url = `${handle.baseUrl}/v1/stream/${streamId}?offset=-1`;

      const response = await fetch(url);
      expect(response.status).toBe(404);
      expectCors(response.headers);
      const cacheControl = response.headers.get("Cache-Control") ?? "";
      expect(cacheControl).toContain("no-store");
    });

    it("includes CORS and no-store on 409 responses", async () => {
      const streamId = uniqueStreamId("cors-409");
      const url = `${handle.baseUrl}/v1/stream/${streamId}`;

      const create = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
      });
      expect([200, 201]).toContain(create.status);

      const conflict = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
      });
      expect(conflict.status).toBe(409);
      expectCors(conflict.headers);
      const cacheControl = conflict.headers.get("Cache-Control") ?? "";
      expect(cacheControl).toContain("no-store");
    });

    it("applies private cache mode to HEAD responses", async () => {
      const streamId = uniqueStreamId("cors-head-private");
      const url = `${handle.baseUrl}/v1/stream/${streamId}`;

      const create = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
      });
      expect([200, 201]).toContain(create.status);

      const head = await fetch(url, { method: "HEAD" });
      expect(head.status).toBe(200);
      expectCors(head.headers);
      const cacheControl = head.headers.get("Cache-Control") ?? "";
      expect(cacheControl).toBe("private, no-store");
    });
  });

  describe("with CACHE_MODE=shared", () => {
    let handle: WorkerHandle;

    beforeAll(async () => {
      handle = await startWorker({ vars: { CACHE_MODE: "shared" } });
    });

    afterAll(async () => {
      await handle.stop();
    });

    it("keeps no-store on HEAD in shared mode", async () => {
      const streamId = uniqueStreamId("cors-head-shared");
      const url = `${handle.baseUrl}/v1/stream/${streamId}`;

      const create = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
      });
      expect([200, 201]).toContain(create.status);

      const head = await fetch(url, { method: "HEAD" });
      expect(head.status).toBe(200);
      expectCors(head.headers);
      const cacheControl = head.headers.get("Cache-Control") ?? "";
      expect(cacheControl).toContain("no-store");
    });
  });
});
