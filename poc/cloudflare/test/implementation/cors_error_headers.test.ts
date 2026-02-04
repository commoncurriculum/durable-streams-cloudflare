import { describe, expect, it } from "vitest";
import { startWorker } from "./worker_harness";
import { uniqueStreamId } from "./helpers";

function expectCors(headers: Headers): void {
  expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(headers.get("Access-Control-Allow-Methods")).toContain("GET");
  expect(headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
}

describe("CORS + error cache headers", () => {
  it("includes CORS and no-store on 401 responses", async () => {
    const handle = await startWorker({ vars: { AUTH_TOKEN: "test-token" } });
    const streamId = uniqueStreamId("cors-401");
    const url = `${handle.baseUrl}/v1/stream/${streamId}`;

    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "hello",
      });
      expect(response.status).toBe(401);
      expectCors(response.headers);
      const cacheControl = response.headers.get("Cache-Control") ?? "";
      expect(cacheControl).toContain("no-store");
    } finally {
      await handle.stop();
    }
  });

  it("includes CORS and no-store on 404 responses", async () => {
    const handle = await startWorker();
    const streamId = uniqueStreamId("cors-404");
    const url = `${handle.baseUrl}/v1/stream/${streamId}?offset=-1`;

    try {
      const response = await fetch(url);
      expect(response.status).toBe(404);
      expectCors(response.headers);
      const cacheControl = response.headers.get("Cache-Control") ?? "";
      expect(cacheControl).toContain("no-store");
    } finally {
      await handle.stop();
    }
  });

  it("includes CORS and no-store on 409 responses", async () => {
    const handle = await startWorker();
    const streamId = uniqueStreamId("cors-409");
    const url = `${handle.baseUrl}/v1/stream/${streamId}`;

    try {
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
    } finally {
      await handle.stop();
    }
  });
});
