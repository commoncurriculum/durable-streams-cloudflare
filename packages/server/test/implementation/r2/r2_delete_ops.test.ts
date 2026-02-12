import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorker, type WorkerHandle } from "../worker_harness";
import { uniqueStreamId } from "../helpers";

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
  describe("with default config (deletes ops)", () => {
    let handle: WorkerHandle;

    beforeAll(async () => {
      handle = await startWorker();
    });

    afterAll(async () => {
      await handle.stop();
    });

    it("deletes ops by default after rotation", async () => {
      const streamId = uniqueStreamId("ops-delete");
      await seedAndRotate(handle.baseUrl, streamId);
      const count = await fetchOpsCount(handle.baseUrl, streamId);
      expect(count).toBe(0);
    });
  });

  describe("with R2_DELETE_OPS=0", () => {
    let handle: WorkerHandle;

    beforeAll(async () => {
      handle = await startWorker({ vars: { R2_DELETE_OPS: "0" } });
    });

    afterAll(async () => {
      await handle.stop();
    });

    it("retains ops when R2_DELETE_OPS=0", async () => {
      const streamId = uniqueStreamId("ops-retain");
      await seedAndRotate(handle.baseUrl, streamId);
      const count = await fetchOpsCount(handle.baseUrl, streamId);
      expect(count).toBeGreaterThan(0);
    });
  });
});
