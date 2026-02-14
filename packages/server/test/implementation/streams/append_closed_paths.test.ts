import { describe, expect, it } from "vitest";
import { createClient, uniqueStreamId } from "../helpers";

describe("append closed-stream paths", () => {
  it("returns 409 for regular append (no close flag) to a closed stream", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("closed-no-flag");

    await client.createStream(streamId, "seed", "text/plain");

    // Close the stream
    const closeRes = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: { "Stream-Closed": "true" },
    });
    expect(closeRes.status).toBe(204);

    // Regular POST with body but WITHOUT Stream-Closed header
    const appendRes = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "late data",
    });

    expect(appendRes.status).toBe(409);
    expect(appendRes.headers.get("Stream-Closed")).toBe("true");
  });

  it("returns idempotent 204 for close-only on already-closed stream", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("close-idem");

    await client.createStream(streamId, "seed", "text/plain");

    // Close the stream
    await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: { "Stream-Closed": "true" },
    });

    // Close again (no body, no Content-Type)
    const secondClose = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: { "Stream-Closed": "true" },
    });

    expect(secondClose.status).toBe(204);
    expect(secondClose.headers.get("Stream-Closed")).toBe("true");
    expect(secondClose.headers.get("Stream-Next-Offset")).toBeTruthy();
  });

  it("returns 404 for append to non-existent stream", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("nonexistent");

    const res = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "data",
    });

    expect(res.status).toBe(404);
  });

  it("returns 204 with producer headers for close-only on already-closed stream", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("prod-close-idem");

    await client.createStream(streamId, "", "text/plain");

    // Producer append to establish producer state
    const firstAppend = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Producer-Id": "p1",
        "Producer-Epoch": "1",
        "Producer-Seq": "0",
      },
      body: "msg-0",
    });
    expect(firstAppend.status).toBe(200);

    // Close the stream
    const closeRes = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: { "Stream-Closed": "true" },
    });
    expect(closeRes.status).toBe(204);

    // Close-only with new producer headers on already-closed stream
    const secondClose = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Stream-Closed": "true",
        "Producer-Id": "p2",
        "Producer-Epoch": "1",
        "Producer-Seq": "0",
      },
    });

    expect(secondClose.status).toBe(204);
    expect(secondClose.headers.get("Stream-Closed")).toBe("true");
    expect(secondClose.headers.get("Producer-Epoch")).toBe("1");
    expect(secondClose.headers.get("Producer-Seq")).toBe("0");
    expect(secondClose.headers.get("Stream-Next-Offset")).toBeTruthy();
  });

  it("returns 204 with producer dedup for replay on closed stream", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("prod-dedup-closed");

    await client.createStream(streamId, "", "text/plain");

    // Producer append with close (body + Stream-Closed)
    const firstRes = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Producer-Id": "p1",
        "Producer-Epoch": "1",
        "Producer-Seq": "0",
        "Stream-Closed": "true",
      },
      body: "final-msg",
    });
    expect(firstRes.status).toBe(200);
    expect(firstRes.headers.get("Stream-Closed")).toBe("true");

    // Replay the same producer append (same P-Id, P-Epoch, P-Seq, with body + close)
    const replayRes = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Producer-Id": "p1",
        "Producer-Epoch": "1",
        "Producer-Seq": "0",
        "Stream-Closed": "true",
      },
      body: "final-msg-retry",
    });

    expect(replayRes.status).toBe(204);
    expect(replayRes.headers.get("Producer-Epoch")).toBe("1");
    expect(replayRes.headers.get("Producer-Seq")).toBe("0");
    expect(replayRes.headers.get("Stream-Closed")).toBe("true");
  });

  it("creates a pre-closed stream with PUT and rejects subsequent appends", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("pre-closed");

    // PUT with body and Stream-Closed: true
    const createRes = await fetch(client.streamUrl(streamId, { public: "true" }), {
      method: "PUT",
      headers: {
        "Content-Type": "text/plain",
        "Stream-Closed": "true",
      },
      body: "final",
    });

    expect(createRes.status).toBe(201);
    expect(createRes.headers.get("Stream-Closed")).toBe("true");

    // Subsequent POST should be rejected
    const appendRes = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "more data",
    });

    expect(appendRes.status).toBe(409);
    expect(appendRes.headers.get("Stream-Closed")).toBe("true");
  });
});
