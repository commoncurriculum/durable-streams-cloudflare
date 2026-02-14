import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, delay, uniqueStreamId } from "../helpers";

describe("long-poll pre-cache warming and concurrent waiters", () => {
  it(
    "pre-cache warming: long-poll waiter gets 200 with cacheable headers when data arrives",
    { timeout: 30000 },
    async () => {
      const client = createClient();
      const streamId = uniqueStreamId("lp-precache");

      // Create stream with initial data
      await client.createStream(streamId, "initial", "text/plain");

      // Read to get the tail offset
      const readRes = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
      expect(readRes.status).toBe(200);
      const tailOffset = readRes.headers.get("Stream-Next-Offset")!;
      expect(tailOffset).toBeTruthy();
      await readRes.arrayBuffer(); // consume body

      // Start long-poll at the tail offset (will block waiting for data)
      // and after a delay, append new data so it wakes up
      const [response] = await Promise.all([
        fetch(client.streamUrl(streamId, { offset: tailOffset, live: "long-poll" })),
        (async () => {
          // Give long-poll time to register as a waiter
          await delay(500);
          await client.appendStream(streamId, "new-data", "text/plain");
        })(),
      ]);

      // The long-poll should resolve with 200 and the new data
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toBe("new-data");

      // The response should have a cacheable Cache-Control (not no-store),
      // because the pre-cache path puts `public, max-age=N` on the response.
      const cacheControl = response.headers.get("Cache-Control");
      expect(cacheControl).toBeTruthy();
      expect(cacheControl).not.toBe("no-store");
      expect(cacheControl).toMatch(/public/);

      // Should also have the standard stream headers
      expect(response.headers.get("Stream-Next-Offset")).toBeTruthy();
    },
  );

  it(
    "multiple concurrent long-poll waiters all resolve when data arrives",
    { timeout: 30000 },
    async () => {
      const client = createClient();
      const streamId = uniqueStreamId("lp-multi");

      // Create stream with initial data
      await client.createStream(streamId, "seed", "text/plain");

      // Read to get the tail offset
      const readRes = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
      expect(readRes.status).toBe(200);
      const tailOffset = readRes.headers.get("Stream-Next-Offset")!;
      await readRes.arrayBuffer();

      // Start 3 concurrent long-poll requests at the tail offset
      const longPollUrl = client.streamUrl(streamId, {
        offset: tailOffset,
        live: "long-poll",
      });

      const [r1, r2, r3] = await Promise.all([
        fetch(longPollUrl),
        fetch(longPollUrl),
        fetch(longPollUrl),
        (async () => {
          // Give long-polls time to register as waiters
          await delay(500);
          await client.appendStream(streamId, "broadcast-data", "text/plain");
        })(),
      ]);

      // All three should resolve with 200 and the appended data
      // (The stagger pattern may cause slight timing differences, but all
      // should resolve within the test timeout.)
      for (const [i, res] of [r1, r2, r3].entries()) {
        expect(res.status, `waiter ${i} should get 200`).toBe(200);
        const body = await res.text();
        expect(body, `waiter ${i} should get the appended data`).toBe("broadcast-data");
        expect(
          res.headers.get("Stream-Next-Offset"),
          `waiter ${i} should have Stream-Next-Offset`,
        ).toBeTruthy();
      }
    },
  );

  it(
    "long-poll waiters at different offsets each get data from their offset",
    { timeout: 30000 },
    async () => {
      const client = createClient();
      const streamId = uniqueStreamId("lp-diffoff");

      // Create stream with initial data ("aaa")
      await client.createStream(streamId, "aaa", "text/plain");

      // Read to get the offset after "aaa"
      const read1 = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
      expect(read1.status).toBe(200);
      const offsetAfterAaa = read1.headers.get("Stream-Next-Offset")!;
      await read1.arrayBuffer();

      // Append "bbb"
      await client.appendStream(streamId, "bbb", "text/plain");

      // Read from offsetAfterAaa to get the offset after "bbb"
      const read2 = await fetch(client.streamUrl(streamId, { offset: offsetAfterAaa }));
      expect(read2.status).toBe(200);
      const offsetAfterBbb = read2.headers.get("Stream-Next-Offset")!;
      await read2.arrayBuffer();

      // Now start two long-poll waiters at different offsets:
      //   Waiter A: at offsetAfterAaa (has unread "bbb" but is waiting for "ccc")
      //   Waiter B: at offsetAfterBbb (waiting for new data)
      // Then append "ccc" to wake both up.

      // Waiter A at offsetAfterAaa will get "bbb" immediately (data is already there),
      // so we need to set it up differently. Actually: since "bbb" is already written,
      // a long-poll at offsetAfterAaa will return immediately with "bbb".
      // The interesting case is both waiters at the tail (offsetAfterBbb) but
      // we already tested that above.
      //
      // Instead, let's test: two waiters at the same tail, and one at an earlier offset
      // where data already exists. The earlier-offset waiter returns immediately,
      // while the tail waiters block until new data arrives.

      // Waiter at offsetAfterAaa should return immediately with "bbb"
      const immediateRes = await fetch(
        client.streamUrl(streamId, { offset: offsetAfterAaa, live: "long-poll" }),
      );
      expect(immediateRes.status).toBe(200);
      const immediateBody = await immediateRes.text();
      expect(immediateBody).toBe("bbb");

      // Now two waiters at the tail, plus an append
      const [tailWaiter1, tailWaiter2] = await Promise.all([
        fetch(client.streamUrl(streamId, { offset: offsetAfterBbb, live: "long-poll" })),
        fetch(client.streamUrl(streamId, { offset: offsetAfterBbb, live: "long-poll" })),
        (async () => {
          await delay(500);
          await client.appendStream(streamId, "ccc", "text/plain");
        })(),
      ]);

      // Both tail waiters should get "ccc"
      expect(tailWaiter1.status).toBe(200);
      expect(await tailWaiter1.text()).toBe("ccc");

      expect(tailWaiter2.status).toBe(200);
      expect(await tailWaiter2.text()).toBe("ccc");

      // Now verify we can read the full stream from zero and get everything
      const fullRead = await client.readAllText(streamId, ZERO_OFFSET);
      expect(fullRead).toBe("aaabbbccc");
    },
  );

  it(
    "long-poll response after wake-up includes ETag header",
    { timeout: 30000 },
    async () => {
      const client = createClient();
      const streamId = uniqueStreamId("lp-etag");

      await client.createStream(streamId, "start", "text/plain");

      // Read to get the tail offset
      const readRes = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
      const tailOffset = readRes.headers.get("Stream-Next-Offset")!;
      await readRes.arrayBuffer();

      const [response] = await Promise.all([
        fetch(client.streamUrl(streamId, { offset: tailOffset, live: "long-poll" })),
        (async () => {
          await delay(500);
          await client.appendStream(streamId, "etag-test", "text/plain");
        })(),
      ]);

      expect(response.status).toBe(200);
      await response.arrayBuffer(); // consume body

      // After wake-up, the response should have an ETag for cacheability
      expect(response.headers.get("ETag")).toBeTruthy();
    },
  );

  it(
    "long-poll waiter at tail gets correct Content-Type from stream",
    { timeout: 30000 },
    async () => {
      const client = createClient();
      const streamId = uniqueStreamId("lp-ctype");

      await client.createStream(streamId, "init", "text/plain");

      const readRes = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
      const tailOffset = readRes.headers.get("Stream-Next-Offset")!;
      await readRes.arrayBuffer();

      const [response] = await Promise.all([
        fetch(client.streamUrl(streamId, { offset: tailOffset, live: "long-poll" })),
        (async () => {
          await delay(500);
          await client.appendStream(streamId, "typed-data", "text/plain");
        })(),
      ]);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/plain");
      expect(await response.text()).toBe("typed-data");
    },
  );
});
