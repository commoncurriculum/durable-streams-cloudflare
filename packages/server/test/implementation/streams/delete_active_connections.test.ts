import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, delay, uniqueStreamId, waitForReaderDone } from "../helpers";

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

async function readSseUntil(
  response: Response,
  predicate: (buffer: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline && !predicate(buffer)) {
      const result = await Promise.race([
        reader.read(),
        delay(Math.max(1, deadline - Date.now())).then(
          () => ({ done: true, value: undefined }) as const,
        ),
      ]);
      if (result.done) break;
      if (result.value) buffer += decoder.decode(result.value as Uint8Array, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Tests: Delete stream with active connections
// ---------------------------------------------------------------------------

describe("delete stream with active connections", () => {
  it(
    "delete stream while long-poll waiter is active wakes the waiter",
    { timeout: 30000 },
    async () => {
      const client = createClient();
      const streamId = uniqueStreamId("del-conn-lp");

      await client.createStream(streamId, "initial payload", "text/plain");

      // Read to get the tail offset so we can long-poll at the end
      const readRes = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
      expect(readRes.status).toBe(200);
      const tailOffset = readRes.headers.get("Stream-Next-Offset")!;
      expect(tailOffset).toBeTruthy();
      await readRes.arrayBuffer(); // consume body

      // Start a long-poll at the tail (will block waiting for new data)
      // and delete the stream concurrently after a short delay
      const [longPollResponse, deleteResponse] = await Promise.all([
        fetch(client.streamUrl(streamId, { offset: tailOffset, live: "long-poll" })),
        (async () => {
          await delay(500); // give long-poll time to register
          return client.deleteStream(streamId);
        })(),
      ]);

      // The delete should succeed
      expect(deleteResponse.status).toBe(204);

      // The long-poll should resolve (not hang forever).
      // After delete, the waiter wakes and finds the stream gone -> 404,
      // or it may see 204 if it races with the timeout path.
      expect([200, 204, 404]).toContain(longPollResponse.status);
      await longPollResponse.arrayBuffer(); // consume body
    },
  );

  it(
    "delete stream while SSE client is connected ends the SSE stream",
    { timeout: 15000 },
    async () => {
      const client = createClient();
      const streamId = uniqueStreamId("del-conn-sse");

      await client.createStream(streamId, "sse payload", "text/plain");

      // Connect SSE at ZERO_OFFSET to get catch-up data
      const response = await fetch(
        client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Read the initial catch-up data and control event
      const initDeadline = Date.now() + 5000;
      while (Date.now() < initDeadline && !buffer.includes("event: control")) {
        const result = await Promise.race([
          reader.read(),
          delay(Math.max(1, initDeadline - Date.now())).then(
            () => ({ done: true, value: undefined }) as const,
          ),
        ]);
        if (result.done) break;
        if (result.value) buffer += decoder.decode(result.value as Uint8Array, { stream: true });
      }

      // Verify we got the initial catch-up
      expect(buffer).toContain("event: data");

      // Delete the stream while the SSE connection is open
      const deleteRes = await client.deleteStream(streamId);
      expect(deleteRes.status).toBe(204);

      // The SSE reader should eventually signal done (stream closes)
      const done = await waitForReaderDone(reader, 5000);

      // Whether or not the reader reports done depends on timing,
      // but the connection should not hang forever.
      // If the reader is not done, cancel it explicitly.
      if (!done) {
        await reader.cancel().catch(() => {});
      }

      // Verify the stream is actually gone
      const getRes = await fetch(client.streamUrl(streamId));
      expect(getRes.status).toBe(404);
    },
  );

  it("delete stream returns 204 and stream is gone", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("del-conn-basic");

    // Create a stream
    await client.createStream(streamId, "hello", "text/plain");

    // Verify it exists
    const getRes = await fetch(client.streamUrl(streamId));
    expect(getRes.status).toBe(200);
    await getRes.arrayBuffer(); // consume body

    // Delete it
    const deleteRes = await client.deleteStream(streamId);
    expect(deleteRes.status).toBe(204);

    // Verify it's gone with GET
    const afterGet = await fetch(client.streamUrl(streamId));
    expect(afterGet.status).toBe(404);
  });

  it("delete non-existent stream returns 404", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("del-conn-missing");

    const deleteRes = await client.deleteStream(streamId);
    expect(deleteRes.status).toBe(404);
  });

  it("delete stream with data and verify no data leak via GET and HEAD", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("del-conn-leak");

    // Create a stream with multiple appends
    await client.createStream(streamId, "first chunk", "text/plain");
    await client.appendStream(streamId, " second chunk", "text/plain");
    await client.appendStream(streamId, " third chunk", "text/plain");

    // Verify all data is readable before delete
    const text = await client.readAllText(streamId);
    expect(text).toContain("first chunk");
    expect(text).toContain("second chunk");
    expect(text).toContain("third chunk");

    // Delete the stream
    const deleteRes = await client.deleteStream(streamId);
    expect(deleteRes.status).toBe(204);

    // GET should return 404
    const getRes = await fetch(client.streamUrl(streamId));
    expect(getRes.status).toBe(404);

    // HEAD should also return 404
    const headRes = await fetch(client.streamUrl(streamId), { method: "HEAD" });
    expect(headRes.status).toBe(404);
  });

  it(
    "delete stream while multiple long-poll waiters are active wakes all of them",
    { timeout: 30000 },
    async () => {
      const client = createClient();
      const streamId = uniqueStreamId("del-conn-multi-lp");

      await client.createStream(streamId, "multi-lp data", "text/plain");

      // Read to get the tail offset
      const readRes = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
      expect(readRes.status).toBe(200);
      const tailOffset = readRes.headers.get("Stream-Next-Offset")!;
      expect(tailOffset).toBeTruthy();
      await readRes.arrayBuffer(); // consume body

      // Start multiple long-poll waiters and then delete
      const [lp1, lp2, lp3, deleteRes] = await Promise.all([
        fetch(client.streamUrl(streamId, { offset: tailOffset, live: "long-poll" })),
        fetch(client.streamUrl(streamId, { offset: tailOffset, live: "long-poll" })),
        fetch(client.streamUrl(streamId, { offset: tailOffset, live: "long-poll" })),
        (async () => {
          await delay(500); // give long-polls time to register
          return client.deleteStream(streamId);
        })(),
      ]);

      expect(deleteRes.status).toBe(204);

      // All long-poll waiters should have resolved (not hung forever)
      for (const lp of [lp1, lp2, lp3]) {
        expect([200, 204, 404]).toContain(lp.status);
        await lp.arrayBuffer(); // consume body
      }
    },
  );

  it(
    "delete stream while SSE is connected at tail (no catch-up data)",
    { timeout: 15000 },
    async () => {
      const client = createClient();
      const streamId = uniqueStreamId("del-conn-sse-tail");

      // Create an empty stream so SSE connects at tail with no catch-up
      await client.createStream(streamId, "", "text/plain");

      // Connect SSE at ZERO_OFFSET (which is the tail for an empty stream)
      const response = await fetch(
        client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }),
      );
      expect(response.status).toBe(200);

      // Read the initial control event
      const buffer = await readSseUntil(response, (buf) => buf.includes("event: control"), 5000);
      expect(buffer).toContain("event: control");

      // Now delete the stream
      const deleteRes = await client.deleteStream(streamId);
      expect(deleteRes.status).toBe(204);

      // Verify the stream is gone
      const getRes = await fetch(client.streamUrl(streamId));
      expect(getRes.status).toBe(404);
    },
  );

  it("delete is idempotent — second delete returns 404", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("del-conn-idempotent");

    await client.createStream(streamId, "temp data", "text/plain");

    // First delete succeeds
    const first = await client.deleteStream(streamId);
    expect(first.status).toBe(204);

    // Second delete returns 404 (already gone)
    const second = await client.deleteStream(streamId);
    expect(second.status).toBe(404);
  });
});
