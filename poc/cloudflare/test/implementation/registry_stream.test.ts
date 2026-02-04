import { describe, expect, it } from "vitest";
import { delay } from "./helpers";
import { startWorker } from "./worker_harness";
import { uniqueStreamId } from "./helpers";

type RegistryEvent = {
  type: string;
  key: string;
  value?: { path: string; contentType: string; createdAt: number };
  headers?: { operation?: string };
};

async function readRegistry(baseUrl: string): Promise<RegistryEvent[]> {
  const response = await fetch(`${baseUrl}/v1/stream/__registry__?offset=-1`);
  if (response.status === 404) {
    return [];
  }
  if (response.status !== 200) {
    throw new Error(`registry read failed: ${response.status} ${await response.text()}`);
  }
  const text = await response.text();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function waitForRegistry(
  baseUrl: string,
  predicate: (events: RegistryEvent[]) => boolean,
): Promise<RegistryEvent[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = await readRegistry(baseUrl);
    if (predicate(events)) return events;
    await delay(100);
  }
  throw new Error("timed out waiting for registry event");
}

describe("registry stream events", () => {
  it("emits create/delete events", async () => {
    const handle = await startWorker();
    const streamId = uniqueStreamId("registry");
    const url = `${handle.baseUrl}/v1/stream/${streamId}`;

    try {
      const create = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
      });
      expect([200, 201]).toContain(create.status);

      const afterCreate = await waitForRegistry(handle.baseUrl, (events) =>
        events.some((event) => event.key === streamId && event.headers?.operation === "insert"),
      );
      const insertIndex = afterCreate.findIndex(
        (event) => event.key === streamId && event.headers?.operation === "insert",
      );
      expect(insertIndex).toBeGreaterThanOrEqual(0);
      const insertEvent = afterCreate[insertIndex];
      expect(insertEvent.value?.path).toBe(streamId);
      expect(insertEvent.value?.contentType).toBe("text/plain");

      const deleted = await fetch(url, { method: "DELETE" });
      expect(deleted.status).toBe(204);

      const afterDelete = await waitForRegistry(handle.baseUrl, (events) =>
        events.some((event) => event.key === streamId && event.headers?.operation === "delete"),
      );
      const deleteIndex = afterDelete.findIndex(
        (event) => event.key === streamId && event.headers?.operation === "delete",
      );
      expect(deleteIndex).toBeGreaterThanOrEqual(0);
      expect(deleteIndex).toBeGreaterThan(insertIndex);
    } finally {
      await handle.stop();
    }
  });
});
