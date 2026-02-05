import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorker, type WorkerHandle } from "./worker_harness";
import { uniqueStreamId } from "./helpers";
import { ZERO_OFFSET } from "../../src/protocol/offsets";

describe("ETag behavior", () => {
  let handle: WorkerHandle;

  beforeAll(async () => {
    handle = await startWorker();
  });

  afterAll(async () => {
    await handle.stop();
  });

  it("returns stable ETag and supports If-None-Match", async () => {
    const streamId = uniqueStreamId("etag");
    const baseUrl = `${handle.baseUrl}/v1/stream/${streamId}`;

    const create = await fetch(baseUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
    });
    expect([200, 201]).toContain(create.status);

    const firstAppend = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "alpha",
    });
    expect([200, 204]).toContain(firstAppend.status);

    const firstRead = await fetch(`${baseUrl}?offset=${ZERO_OFFSET}`);
    expect(firstRead.status).toBe(200);
    const firstEtag = firstRead.headers.get("ETag");
    expect(firstEtag).toBeTruthy();

    const notModified = await fetch(`${baseUrl}?offset=${ZERO_OFFSET}`, {
      headers: { "If-None-Match": firstEtag ?? "" },
    });
    expect(notModified.status).toBe(304);

    const secondAppend = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "beta",
    });
    expect([200, 204]).toContain(secondAppend.status);

    const secondRead = await fetch(`${baseUrl}?offset=${ZERO_OFFSET}`);
    expect(secondRead.status).toBe(200);
    const secondEtag = secondRead.headers.get("ETag");
    expect(secondEtag).toBeTruthy();
    expect(secondEtag).not.toEqual(firstEtag);
  });
});
