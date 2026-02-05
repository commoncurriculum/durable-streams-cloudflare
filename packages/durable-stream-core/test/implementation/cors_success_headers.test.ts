import { describe, expect, it } from "vitest";
import { uniqueStreamId } from "./helpers";
import { startWorker } from "./worker_harness";

describe("CORS success headers", () => {
  it("adds CORS headers to successful stream responses", async () => {
    const handle = await startWorker();
    const streamId = uniqueStreamId("cors-ok");
    const streamUrl = `${handle.baseUrl}/v1/stream/${streamId}`;

    try {
      const create = await fetch(streamUrl, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
      });
      expect([200, 201]).toContain(create.status);
      expect(create.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(create.headers.get("Access-Control-Allow-Methods")).toContain("GET");
      expect(create.headers.get("Access-Control-Expose-Headers")).toContain("Stream-Next-Offset");

      const read = await fetch(`${streamUrl}?offset=0_0000000000000000`);
      expect(read.status).toBe(200);
      expect(read.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(read.headers.get("Access-Control-Expose-Headers")).toContain("ETag");
    } finally {
      await handle.stop();
    }
  });

  it("returns CORS headers on OPTIONS preflight", async () => {
    const handle = await startWorker();
    const streamId = uniqueStreamId("cors-options");
    const streamUrl = `${handle.baseUrl}/v1/stream/${streamId}`;

    try {
      const response = await fetch(streamUrl, { method: "OPTIONS" });
      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain("OPTIONS");
      expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
      expect(response.headers.get("Access-Control-Expose-Headers")).toContain("Stream-Next-Offset");
    } finally {
      await handle.stop();
    }
  });
});
