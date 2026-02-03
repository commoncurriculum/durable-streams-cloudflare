import { describe, expect, it } from "vitest";
import {
  createStream,
  delay,
  deleteStream,
  streamUrl,
  uniqueStreamId,
  waitForReaderDone,
} from "./helpers";

describe("stream cleanup", () => {
  it("closes SSE connections when a stream is deleted", async () => {
    const streamId = uniqueStreamId("sse-delete");
    await createStream(streamId, "hello", "text/plain");

    const response = await fetch(streamUrl(streamId, { live: "sse", offset: "0" }), {
      headers: {
        Accept: "text/event-stream",
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();

    const reader = response.body!.getReader();

    await deleteStream(streamId);

    const closed = await waitForReaderDone(reader, 1500);
    expect(closed).toBe(true);
  });

  it("wakes long-poll waiters after delete", async () => {
    const streamId = uniqueStreamId("longpoll-delete");
    const putResponse = await createStream(streamId, "", "text/plain");
    const tailOffset = putResponse.headers.get("Stream-Next-Offset");
    expect(tailOffset).toBeTruthy();

    const longPollUrl = streamUrl(streamId, {
      live: "long-poll",
      offset: tailOffset!,
    });

    const start = Date.now();
    const longPollPromise = fetch(longPollUrl);

    await delay(50);
    await deleteStream(streamId);

    const longPollResponse = await longPollPromise;
    const elapsed = Date.now() - start;

    expect(longPollResponse.status).toBe(404);
    expect(elapsed).toBeLessThan(1500);
  });
});
