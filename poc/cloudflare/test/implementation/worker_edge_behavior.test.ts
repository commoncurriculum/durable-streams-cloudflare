import { describe, expect, it } from "vitest";
import { ZERO_OFFSET, decodeOffsetParts, encodeOffset } from "../../src/protocol/offsets";
import { startWorker } from "./worker_harness";
import { uniqueStreamId } from "./helpers";

describe("worker edge behavior", () => {
  it("rejects requests without the configured auth token", async () => {
    const handle = await startWorker({ vars: { AUTH_TOKEN: "test-token" } });
    const streamId = uniqueStreamId("auth");
    const url = `${handle.baseUrl}/v1/stream/${streamId}`;

    try {
      const unauthorized = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "hello",
      });
      expect(unauthorized.status).toBe(401);

      const authorized = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          Authorization: "Bearer test-token",
        },
        body: "hello",
      });
      expect([200, 201]).toContain(authorized.status);
    } finally {
      await handle.stop();
    }
  });

  it("marks hot reads as private/no-store and cold reads as public", async () => {
    const handle = await startWorker();
    const streamId = uniqueStreamId("cache");
    const url = `${handle.baseUrl}/v1/stream/${streamId}`;

    try {
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

      const coldRead = await fetch(`${url}?offset=${ZERO_OFFSET}`);
      expect(coldRead.status).toBe(200);
      const coldCache = coldRead.headers.get("Cache-Control") ?? "";
      expect(coldCache).toContain("public");
      expect(coldCache).toContain("max-age");
      expect(coldCache).not.toContain("no-store");

      const hotOffset = encodeOffset(Math.max(0, decoded!.byteOffset - 1), decoded!.readSeq);
      const hotRead = await fetch(`${url}?offset=${hotOffset}`);
      expect(hotRead.status).toBe(200);
      const hotCache = hotRead.headers.get("Cache-Control") ?? "";
      expect(hotCache).toBe("private, no-store");
    } finally {
      await handle.stop();
    }
  });

  it("emits Server-Timing when debug is enabled", async () => {
    const handle = await startWorker();
    const streamId = uniqueStreamId("timing");
    const url = `${handle.baseUrl}/v1/stream/${streamId}`;

    try {
      const create = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain", "X-Debug-Timing": "1" },
        body: "hello",
      });
      expect([200, 201]).toContain(create.status);
      const timing = create.headers.get("Server-Timing");
      expect(timing).toBeTruthy();
      expect(timing ?? "").toContain("edge.origin");
    } finally {
      await handle.stop();
    }
  });
});
