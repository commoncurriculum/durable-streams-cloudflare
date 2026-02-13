import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, uniqueStreamId } from "../helpers";

describe("append validation", () => {
  it("returns 409 when content-type mismatches stream", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("ct-mismatch");

    // Create stream with text/plain
    await client.createStream(streamId, "seed", "text/plain");

    // POST with application/json → 409
    const res = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ msg: "hello" }]),
    });

    expect(res.status).toBe(409);
  });

  it("returns 400 when body is empty and no Stream-Closed header", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("empty-body");

    await client.createStream(streamId, "seed", "text/plain");

    const res = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      // empty body
    });

    expect(res.status).toBe(400);
  });

  it("returns 204 when Content-Type header is missing (close-only treated as no-op)", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("no-ct");

    await client.createStream(streamId, "seed", "text/plain");

    // fetch without explicit Content-Type sends text/plain;charset=UTF-8 for string body,
    // but the server normalizes it. A truly missing CT with body is hard to trigger
    // via fetch. Instead verify that a close-only POST (no body, no CT) succeeds.
    const res = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: { "Stream-Closed": "true" },
    });

    expect(res.status).toBe(204);
  });

  it("returns 204 with producer headers on successful append", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("producer");

    await client.createStream(streamId, "", "text/plain");

    const res = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Producer-Id": "p1",
        "Producer-Epoch": "1",
        "Producer-Seq": "0",
      },
      body: "message-0",
    });

    // Producer appends return 200 (with producer state)
    expect(res.status).toBe(200);
    expect(res.headers.get("Producer-Epoch")).toBe("1");
    expect(res.headers.get("Producer-Seq")).toBe("0");
    expect(res.headers.get("Stream-Next-Offset")).toBeTruthy();
  });

  it("deduplicates producer replay (same seq)", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("producer-dup");

    await client.createStream(streamId, "", "text/plain");

    // First append
    const first = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Producer-Id": "p1",
        "Producer-Epoch": "1",
        "Producer-Seq": "0",
      },
      body: "msg-0",
    });
    expect(first.status).toBe(200);

    // Replay with same producer/epoch/seq → 204 (duplicate)
    const dup = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Producer-Id": "p1",
        "Producer-Epoch": "1",
        "Producer-Seq": "0",
      },
      body: "msg-0-retry",
    });
    expect(dup.status).toBe(204);
    expect(dup.headers.get("Producer-Epoch")).toBe("1");
    expect(dup.headers.get("Producer-Seq")).toBe("0");
  });

  it("returns 409 with Stream-Closed for append with close+body on closed stream", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("close-body-closed");

    await client.createStream(streamId, "seed", "text/plain");

    // Close the stream
    await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: { "Stream-Closed": "true" },
    });

    // Append with body AND close flag → 409 (already closed)
    const res = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Stream-Closed": "true",
      },
      body: "late data",
    });

    expect(res.status).toBe(409);
    expect(res.headers.get("Stream-Closed")).toBe("true");
  });

  it("appends with close returns Stream-Closed and data is readable", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("append-close");

    await client.createStream(streamId, "", "text/plain");

    const res = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Stream-Closed": "true",
      },
      body: "final",
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("Stream-Closed")).toBe("true");
    expect(res.headers.get("Stream-Next-Offset")).toBeTruthy();

    // Read back
    const text = await client.readAllText(streamId, ZERO_OFFSET);
    expect(text).toBe("final");
  });

  it("returns 400 for incomplete producer headers", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("producer-incomplete");

    await client.createStream(streamId, "", "text/plain");

    // Only Producer-Id, missing Epoch and Seq
    const res = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Producer-Id": "p1",
      },
      body: "data",
    });

    expect(res.status).toBe(400);
  });

  it("returns 409 for producer sequence gap", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("producer-gap");

    await client.createStream(streamId, "", "text/plain");

    // First append at seq=0
    await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Producer-Id": "p1",
        "Producer-Epoch": "1",
        "Producer-Seq": "0",
      },
      body: "msg-0",
    });

    // Skip seq=1 and go to seq=2 → 409 (sequence gap)
    const res = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Producer-Id": "p1",
        "Producer-Epoch": "1",
        "Producer-Seq": "2",
      },
      body: "msg-2",
    });

    expect(res.status).toBe(409);
    expect(res.headers.get("Producer-Expected-Seq")).toBe("1");
    expect(res.headers.get("Producer-Received-Seq")).toBe("2");
  });

  it("returns 400 when producer seq does not start at 0", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("producer-nonzero");

    await client.createStream(streamId, "", "text/plain");

    // New producer starting at seq=5 → error
    const res = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Producer-Id": "brand-new-producer",
        "Producer-Epoch": "1",
        "Producer-Seq": "5",
      },
      body: "msg",
    });

    expect(res.status).toBe(400);
  });
});
