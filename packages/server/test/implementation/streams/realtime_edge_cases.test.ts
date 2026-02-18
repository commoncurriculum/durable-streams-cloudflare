import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, delay, uniqueStreamId } from "../helpers";

describe("realtime edge cases", () => {
  it(
    "SSE with binary (application/octet-stream) data uses base64 encoding",
    { timeout: 15000 },
    async () => {
      const client = createClient();
      const streamId = uniqueStreamId("sse-binary");

      // Create a binary stream with raw bytes including 0x00 and 0xFF
      const bytes = new Uint8Array([0, 1, 2, 128, 254, 255]);
      await fetch(client.streamUrl(streamId, { public: "true" }), {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
      });

      // Connect via SSE
      const response = await fetch(
        client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
      expect(response.headers.get("Stream-SSE-Data-Encoding")).toBe("base64");

      // Read SSE events until we see the control event
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !buffer.includes("event: control")) {
        const result = await Promise.race([
          reader.read(),
          delay(Math.max(1, deadline - Date.now())).then(
            () => ({ done: true, value: undefined }) as const,
          ),
        ]);
        if (result.done) break;
        if (result.value) buffer += decoder.decode(result.value, { stream: true });
      }
      await reader.cancel().catch(() => {});

      // Verify we got a data event with base64-encoded content
      expect(buffer).toContain("event: data\n");

      // Extract the data line from the data event
      const dataMatch = buffer.match(/event: data\ndata:(.+)\n/);
      expect(dataMatch).toBeTruthy();
      const base64Data = dataMatch![1];

      // Decode the base64 and verify it matches our original bytes
      const decoded = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
      expect(decoded).toEqual(bytes);
    },
  );

  it("long-poll returns 204 on timeout (no new data)", { timeout: 30000 }, async () => {
    const client = createClient();
    const streamId = uniqueStreamId("lp-timeout");

    await client.createStream(streamId, "initial-data", "text/plain");

    // Read to get the tail offset
    const readRes = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
    expect(readRes.status).toBe(200);
    const tailOffset = readRes.headers.get("Stream-Next-Offset")!;
    await readRes.arrayBuffer(); // consume body

    // Long-poll at the tail offset -- no new data will arrive, so it
    // should time out and return 204
    const response = await fetch(
      client.streamUrl(streamId, { offset: tailOffset, live: "long-poll" }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Stream-Up-To-Date")).toBe("true");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("long-poll returns 400 when offset parameter is missing", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("lp-no-offset");

    await client.createStream(streamId, "data", "text/plain");

    // Call long-poll without an offset parameter
    const response = await fetch(client.streamUrl(streamId, { live: "long-poll" }));

    expect(response.status).toBe(400);
  });

  it("SSE returns 400 when offset is missing", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("sse-no-offset");

    await client.createStream(streamId, "data", "text/plain");

    // Call SSE without an offset parameter
    const response = await fetch(client.streamUrl(streamId, { live: "sse" }));

    expect(response.status).toBe(400);
  });

  it(
    "long-poll at offset=now waits for data then times out with no-store",
    { timeout: 30000 },
    async () => {
      const client = createClient();
      const streamId = uniqueStreamId("lp-now");

      await client.createStream(streamId, "some-data", "text/plain");

      // offset=now resolves to tail_offset, then waits for NEW data.
      // Since no data arrives, it times out like a normal long-poll.
      const response = await fetch(
        client.streamUrl(streamId, { offset: "now", live: "long-poll" }),
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Stream-Up-To-Date")).toBe("true");
    },
  );
});
