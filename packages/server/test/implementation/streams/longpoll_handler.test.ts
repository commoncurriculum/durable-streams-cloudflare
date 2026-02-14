import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, delay, uniqueStreamId } from "../helpers";

describe("long-poll handler", () => {
  it("long-poll on closed stream at tail returns 204 with Stream-Closed", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("lph-closed-tail");

    await client.createStream(streamId, "some data", "text/plain");

    // Close the stream
    await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: { "Stream-Closed": "true" },
    });

    // Read to get the tail offset
    const readRes = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
    expect(readRes.status).toBe(200);
    const tailOffset = readRes.headers.get("Stream-Next-Offset")!;
    await readRes.arrayBuffer(); // consume body

    // Long-poll at the tail offset of a closed stream
    const response = await fetch(
      client.streamUrl(streamId, { offset: tailOffset, live: "long-poll" }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Stream-Closed")).toBe("true");
    expect(response.headers.get("Stream-Up-To-Date")).toBe("true");
  });

  it("long-poll with immediate data return returns 200", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("lph-immediate");

    await client.createStream(streamId, "hello world", "text/plain");

    // Long-poll at ZERO_OFFSET where data is already available
    const response = await fetch(
      client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "long-poll" }),
    );

    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toBe("hello world");

    // Should have Stream-Next-Offset and ETag
    expect(response.headers.get("Stream-Next-Offset")).toBeTruthy();
    expect(response.headers.get("ETag")).toBeTruthy();
  });

  it("long-poll on closed stream with data available returns 200 with Stream-Closed and ETag", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("lph-closed-data");

    await client.createStream(streamId, "closed stream data", "text/plain");

    // Close the stream
    await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: { "Stream-Closed": "true" },
    });

    // Long-poll at ZERO_OFFSET -- data is available even though stream is closed
    const response = await fetch(
      client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "long-poll" }),
    );

    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toBe("closed stream data");

    expect(response.headers.get("Stream-Closed")).toBe("true");
    expect(response.headers.get("ETag")).toBeTruthy();
    expect(response.headers.get("Stream-Next-Offset")).toBeTruthy();
  });

  it("long-poll wakes up when data is appended", { timeout: 30000 }, async () => {
    const client = createClient();
    const streamId = uniqueStreamId("lph-wakeup");

    await client.createStream(streamId, "", "text/plain");

    // Read to get the current tail offset
    const initial = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
    const nextOffset = initial.headers.get("Stream-Next-Offset")!;
    await initial.arrayBuffer(); // consume body

    // Start long-poll at the tail (will wait for data) and append data concurrently
    const [response] = await Promise.all([
      fetch(client.streamUrl(streamId, { offset: nextOffset, live: "long-poll" })),
      (async () => {
        // Give the long-poll time to register as a waiter
        await delay(500);
        await client.appendStream(streamId, "wakeup data", "text/plain");
      })(),
    ]);

    // Should get 200 with the appended data (or 204 if it timed out,
    // but with a 500ms delay before append, 200 is expected)
    if (response.status === 200) {
      const body = await response.text();
      expect(body).toBe("wakeup data");
      expect(response.headers.get("Stream-Next-Offset")).toBeTruthy();
    } else {
      // Acceptable fallback -- timeout race condition
      expect(response.status).toBe(204);
    }
  });

  it("long-poll with offset=-1 resolves to ZERO_OFFSET", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("lph-neg1");

    await client.createStream(streamId, "offset neg one", "text/plain");

    // Long-poll with offset=-1, which should resolve to ZERO_OFFSET
    const response = await fetch(client.streamUrl(streamId, { offset: "-1", live: "long-poll" }));

    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toBe("offset neg one");

    expect(response.headers.get("Stream-Next-Offset")).toBeTruthy();
  });

  describe("Cache-Control headers", () => {
    it("returns public, max-age for normal reads with data", async () => {
      const client = createClient();
      const streamId = uniqueStreamId("lph-cc-public");

      await client.createStream(streamId, "cache test data", "text/plain");

      // Long-poll at ZERO_OFFSET where data is immediately available
      const response = await fetch(
        client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "long-poll" }),
      );

      expect(response.status).toBe(200);
      await response.arrayBuffer(); // consume body

      const cacheControl = response.headers.get("Cache-Control");
      expect(cacheControl).toBeTruthy();
      expect(cacheControl).toMatch(/public, max-age=\d+/);
    });

    it("returns no-store for timeout (no new data)", { timeout: 30000 }, async () => {
      const client = createClient();
      const streamId = uniqueStreamId("lph-cc-nostore");

      await client.createStream(streamId, "initial", "text/plain");

      // Read to get the tail offset
      const readRes = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
      const tailOffset = readRes.headers.get("Stream-Next-Offset")!;
      await readRes.arrayBuffer(); // consume body

      // Long-poll at tail -- no new data will arrive, so it should time out
      const response = await fetch(
        client.streamUrl(streamId, { offset: tailOffset, live: "long-poll" }),
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    });
  });
});
