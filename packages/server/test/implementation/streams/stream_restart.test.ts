import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, uniqueStreamId } from "../helpers";
import { createPersistDir, getAvailablePort, startWorker } from "../worker_harness";

const PRODUCER_HEADERS = {
  "Producer-Id": "producer-1",
  "Producer-Epoch": "0",
  "Producer-Seq": "0",
};

describe("worker restart", () => {
  it("persists data across restart", async () => {
    const port = await getAvailablePort();
    const persistDir = await createPersistDir("durable-streams-restart-");

    let worker = await startWorker({ port, persistDir });
    const client = createClient(worker.baseUrl);

    const streamId = uniqueStreamId("restart");
    await client.createStream(streamId, "hello", "text/plain");
    await client.appendStream(streamId, "world", "text/plain");

    const before = await client.readAllText(streamId, ZERO_OFFSET);
    expect(before).toBe("helloworld");

    await worker.stop();
    // Wait for socket cleanup before restarting
    await new Promise((resolve) => setTimeout(resolve, 500));

    worker = await startWorker({ port, persistDir });
    const restartedClient = createClient(worker.baseUrl);

    const after = await restartedClient.readAllText(streamId, ZERO_OFFSET);
    expect(after).toBe("helloworld");

    await worker.stop();
  });

  it("keeps producer appends idempotent across restart", async () => {
    const port = await getAvailablePort();
    const persistDir = await createPersistDir("durable-streams-producer-");

    let worker = await startWorker({ port, persistDir });
    const client = createClient(worker.baseUrl);

    const streamId = uniqueStreamId("producer-restart");
    await client.createStream(streamId, "", "text/plain");

    const firstAppend = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        ...PRODUCER_HEADERS,
      },
      body: "A",
    });

    expect(firstAppend.status).toBe(200);
    const firstOffset = firstAppend.headers.get("Stream-Next-Offset");
    expect(firstOffset).toBeTruthy();

    await worker.stop();
    // Wait for socket cleanup before restarting
    await new Promise((resolve) => setTimeout(resolve, 500));

    worker = await startWorker({ port, persistDir });
    const restartedClient = createClient(worker.baseUrl);

    const duplicateAppend = await fetch(restartedClient.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        ...PRODUCER_HEADERS,
      },
      body: "A",
    });

    expect(duplicateAppend.status).toBe(204);
    expect(duplicateAppend.headers.get("Stream-Next-Offset")).toBe(firstOffset);

    const finalText = await restartedClient.readAllText(streamId, ZERO_OFFSET);
    expect(finalText).toBe("A");

    await worker.stop();
  });
});
