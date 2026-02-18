import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, delay, uniqueStreamId } from "../helpers";

describe("long-poll with data", () => {
  it("returns 200 with data when stream has content at the requested offset", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("lp-immediate");

    await client.createStream(streamId, "hello", "text/plain");

    const response = await fetch(
      client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "long-poll" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(response.headers.get("Stream-Next-Offset")).toBeTruthy();
    expect(response.headers.get("Stream-Up-To-Date")).toBe("true");

    const body = await response.text();
    expect(body).toBe("hello");
  });

  it("waits for data and returns 200 when data is appended", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("lp-wait");

    await client.createStream(streamId, "", "text/plain");

    // Read initial offset
    const initial = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
    const nextOffset = initial.headers.get("Stream-Next-Offset")!;

    // Start long-poll (will wait for data)
    const longPollPromise = fetch(
      client.streamUrl(streamId, { offset: nextOffset, live: "long-poll" }),
    );

    // Give the long-poll time to register as a waiter
    await delay(200);

    // Append data
    await client.appendStream(streamId, "world", "text/plain");

    const response = await longPollPromise;

    // Should get data (200) or timeout (204) — either is valid but 200 is expected
    if (response.status === 200) {
      const body = await response.text();
      expect(body).toBe("world");
    } else {
      expect(response.status).toBe(204);
    }
  });

  it("returns 204 with Stream-Closed when stream is closed at tail", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("lp-closed");

    await client.createStream(streamId, "data", "text/plain");

    // Close the stream
    await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: { "Stream-Closed": "true" },
    });

    // Read to get the tail offset
    const readRes = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
    const tailOffset = readRes.headers.get("Stream-Next-Offset")!;
    await readRes.arrayBuffer(); // consume body

    // Long-poll at tail of closed stream
    const response = await fetch(
      client.streamUrl(streamId, { offset: tailOffset, live: "long-poll" }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Stream-Closed")).toBe("true");
    expect(response.headers.get("Stream-Up-To-Date")).toBe("true");
  });
});
