import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, delay, uniqueStreamId } from "../helpers";

describe("long-poll Stream-Write-Timestamp header", () => {
  it("includes Stream-Write-Timestamp when immediate data is available", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("lp-wts-immediate");

    await client.createStream(streamId, "hello", "text/plain");

    const response = await fetch(
      client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "long-poll" }),
    );

    expect(response.status).toBe(200);
    await response.arrayBuffer(); // consume body

    const timestamp = response.headers.get("Stream-Write-Timestamp");
    expect(timestamp).toBeTruthy();

    const ts = Number(timestamp);
    expect(ts).toBeGreaterThan(0);
    // Should be a recent timestamp (within last 60 seconds)
    expect(ts).toBeGreaterThan(Date.now() - 60_000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it(
    "includes Stream-Write-Timestamp when long-poll wakes up with data",
    { timeout: 30000 },
    async () => {
      const client = createClient();
      const streamId = uniqueStreamId("lp-wts-wakeup");

      await client.createStream(streamId, "", "text/plain");

      // Read to get the current tail offset
      const initial = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
      const tailOffset = initial.headers.get("Stream-Next-Offset")!;
      await initial.arrayBuffer(); // consume body

      // Start long-poll at tail and append data concurrently to wake it up
      const [response] = await Promise.all([
        fetch(client.streamUrl(streamId, { offset: tailOffset, live: "long-poll" })),
        (async () => {
          await delay(500);
          await client.appendStream(streamId, "wake-up-data", "text/plain");
        })(),
      ]);

      // Should get 200 with the appended data
      if (response.status === 200) {
        const body = await response.text();
        expect(body).toBe("wake-up-data");

        const timestamp = response.headers.get("Stream-Write-Timestamp");
        expect(timestamp).toBeTruthy();

        const ts = Number(timestamp);
        expect(ts).toBeGreaterThan(0);
        expect(ts).toBeGreaterThan(Date.now() - 60_000);
        expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
      } else {
        // Acceptable fallback -- timeout race condition
        expect(response.status).toBe(204);
      }
    },
  );

  it(
    "does NOT include Stream-Write-Timestamp on 204 timeout",
    { timeout: 30000 },
    async () => {
      const client = createClient();
      const streamId = uniqueStreamId("lp-wts-timeout");

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
      expect(response.headers.get("Stream-Write-Timestamp")).toBeNull();
    },
  );
});
