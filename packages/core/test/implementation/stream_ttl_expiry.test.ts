import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { delay, uniqueStreamId } from "./helpers";
import { ZERO_OFFSET } from "../../src/protocol/offsets";
import { startWorker, type WorkerHandle } from "./worker_harness";

describe("stream TTL expiry", () => {
  let handle: WorkerHandle;

  beforeAll(async () => {
    handle = await startWorker();
  });

  afterAll(async () => {
    await handle.stop();
  });

  it("expires streams and allows recreation after TTL", async () => {
    const streamId = uniqueStreamId("ttl-expiry");
    const streamUrl = `${handle.baseUrl}/v1/stream/${streamId}`;

    const create = await fetch(streamUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "text/plain",
        "Stream-TTL": "1",
      },
      body: "hello",
    });
    expect([200, 201]).toContain(create.status);

    const readBefore = await fetch(`${streamUrl}?offset=${ZERO_OFFSET}`);
    expect(readBefore.status).toBe(200);

    await delay(2500);

    const readAfter = await fetch(`${streamUrl}?offset=${ZERO_OFFSET}`);
    expect(readAfter.status).toBe(404);

    const recreate = await fetch(streamUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "text/plain",
        "Stream-TTL": "1",
      },
      body: "again",
    });
    expect([200, 201]).toContain(recreate.status);
  });
});
