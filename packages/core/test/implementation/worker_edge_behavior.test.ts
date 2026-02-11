import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../src/http/v1/streams/shared/offsets";
import { startWorker, type WorkerHandle } from "./worker_harness";
import { uniqueStreamId } from "./helpers";

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

  describe("Cache-Control headers", () => {
    let handle: WorkerHandle;

    beforeAll(async () => {
      handle = await startWorker();
    });

    afterAll(async () => {
      await handle.stop();
    });

    it("returns protocol-correct Cache-Control for open stream reads", async () => {
      const streamId = uniqueStreamId("cc-open");
      const url = `${handle.baseUrl}/v1/stream/${streamId}`;

      const create = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "",
      });
      expect([200, 201]).toContain(create.status);

      const append = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "hello",
      });
      expect([200, 204]).toContain(append.status);

      const read = await fetch(`${url}?offset=${ZERO_OFFSET}`);
      expect(read.status).toBe(200);
      expect(read.headers.get("Cache-Control")).toBe(
        "public, max-age=60, stale-while-revalidate=300",
      );
    });

    it("returns protocol-correct Cache-Control for closed stream reads", async () => {
      const streamId = uniqueStreamId("cc-closed");
      const url = `${handle.baseUrl}/v1/stream/${streamId}`;

      const create = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "",
      });
      expect([200, 201]).toContain(create.status);

      const append = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "hello",
      });
      expect([200, 204]).toContain(append.status);

      const close = await fetch(url, {
        method: "POST",
        headers: { "Stream-Closed": "true" },
      });
      expect([200, 204]).toContain(close.status);

      const read = await fetch(`${url}?offset=${ZERO_OFFSET}`);
      expect(read.status).toBe(200);
      expect(read.headers.get("Cache-Control")).toBe(
        "public, max-age=60, stale-while-revalidate=300",
      );
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
