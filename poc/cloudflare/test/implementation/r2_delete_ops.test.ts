import { describe, expect, it } from "vitest";
import { startWorker } from "./worker_harness";
import { uniqueStreamId } from "./helpers";

async function seedAndRotate(baseUrl: string, streamId: string): Promise<void> {
  const url = `${baseUrl}/v1/stream/${streamId}`;
  const create = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
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
    headers: { "X-Debug-Action": "compact" },
  });
  expect(compact.status).toBe(204);
}

async function fetchOpsCount(baseUrl: string, streamId: string): Promise<number> {
  const url = `${baseUrl}/v1/stream/${streamId}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "X-Debug-Action": "ops-count" },
  });
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { count: number };
  return payload.count;
}

describe("R2 op retention", () => {
  it("deletes ops by default after rotation", async () => {
    const handle = await startWorker();
    const streamId = uniqueStreamId("ops-delete");

    try {
      await seedAndRotate(handle.baseUrl, streamId);
      const count = await fetchOpsCount(handle.baseUrl, streamId);
      expect(count).toBe(0);
    } finally {
      await handle.stop();
    }
  });

  it("retains ops when R2_DELETE_OPS=0", async () => {
    const handle = await startWorker({ vars: { R2_DELETE_OPS: "0" } });
    const streamId = uniqueStreamId("ops-retain");

    try {
      await seedAndRotate(handle.baseUrl, streamId);
      const count = await fetchOpsCount(handle.baseUrl, streamId);
      expect(count).toBeGreaterThan(0);
    } finally {
      await handle.stop();
    }
  });
});
