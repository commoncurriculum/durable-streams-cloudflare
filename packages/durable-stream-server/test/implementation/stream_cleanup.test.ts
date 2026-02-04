import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../src/protocol/offsets";
import { createClient, delay, uniqueStreamId, waitForReaderDone } from "./helpers";

describe("stream cleanup", () => {
  it("closes SSE connections when a stream is deleted", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("sse-delete");
    await client.createStream(streamId, "hello", "text/plain");

    const response = await fetch(client.streamUrl(streamId, { live: "sse", offset: ZERO_OFFSET }), {
      headers: {
        Accept: "text/event-stream",
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();

    const reader = response.body!.getReader();

    await client.deleteStream(streamId);

    const closed = await waitForReaderDone(reader, 1500);
    expect(closed).toBe(true);
  });

  it("wakes long-poll waiters after delete", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("longpoll-delete");
    const putResponse = await client.createStream(streamId, "", "text/plain");
    const tailOffset = putResponse.headers.get("Stream-Next-Offset");
    expect(tailOffset).toBeTruthy();

    const longPollUrl = client.streamUrl(streamId, {
      live: "long-poll",
      offset: tailOffset!,
    });

    const start = Date.now();
    const longPollPromise = fetch(longPollUrl);

    await delay(50);
    await client.deleteStream(streamId);

    const longPollResponse = await longPollPromise;
    const elapsed = Date.now() - start;

    expect(longPollResponse.status).toBe(404);
    expect(elapsed).toBeLessThan(1500);
  });
});
