import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, uniqueStreamId } from "../helpers";

describe("close-only with producer on open stream", () => {
  it("closes the stream and records producer state", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("close-prod-open");

    await client.createStream(streamId, "seed data", "text/plain");

    const closeRes = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Stream-Closed": "true",
        "Producer-Id": "closer-1",
        "Producer-Epoch": "1",
        "Producer-Seq": "0",
      },
    });

    expect(closeRes.status).toBe(204);
    expect(closeRes.headers.get("Stream-Closed")).toBe("true");
    expect(closeRes.headers.get("Producer-Epoch")).toBe("1");
    expect(closeRes.headers.get("Producer-Seq")).toBe("0");
    expect(closeRes.headers.get("Stream-Next-Offset")).toBeTruthy();
  });

  it("re-closing with same producer is idempotent", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("close-prod-idem");

    await client.createStream(streamId, "seed data", "text/plain");

    // First close with producer headers
    const firstClose = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Stream-Closed": "true",
        "Producer-Id": "closer-1",
        "Producer-Epoch": "1",
        "Producer-Seq": "0",
      },
    });
    expect(firstClose.status).toBe(204);

    // Replay the exact same close-only — should be idempotent
    const reclose = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Stream-Closed": "true",
        "Producer-Id": "closer-1",
        "Producer-Epoch": "1",
        "Producer-Seq": "0",
      },
    });

    expect(reclose.status).toBe(204);
    expect(reclose.headers.get("Stream-Closed")).toBe("true");
    expect(reclose.headers.get("Producer-Epoch")).toBe("1");
    expect(reclose.headers.get("Producer-Seq")).toBe("0");
  });

  it("close-only with producer after append by same producer", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("close-after-append");

    await client.createStream(streamId, "", "text/plain");

    // Append with producer (seq 0)
    const appendRes = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Producer-Id": "p1",
        "Producer-Epoch": "1",
        "Producer-Seq": "0",
      },
      body: "message",
    });
    expect(appendRes.status).toBe(200);

    // Close with same producer, next seq
    const closeRes = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Stream-Closed": "true",
        "Producer-Id": "p1",
        "Producer-Epoch": "1",
        "Producer-Seq": "1",
      },
    });

    expect(closeRes.status).toBe(204);
    expect(closeRes.headers.get("Stream-Closed")).toBe("true");
    expect(closeRes.headers.get("Producer-Epoch")).toBe("1");
    expect(closeRes.headers.get("Producer-Seq")).toBe("1");
  });

  it("closed stream data is still readable after close with producer", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("close-prod-read");

    await client.createStream(streamId, "", "text/plain");

    // Append data with producer
    const appendRes = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Producer-Id": "reader-prod",
        "Producer-Epoch": "1",
        "Producer-Seq": "0",
      },
      body: "readable-after-close",
    });
    expect(appendRes.status).toBe(200);

    // Close with same producer, next seq
    const closeRes = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Stream-Closed": "true",
        "Producer-Id": "reader-prod",
        "Producer-Epoch": "1",
        "Producer-Seq": "1",
      },
    });
    expect(closeRes.status).toBe(204);

    // Read back the stream — data should still be there
    const text = await client.readAllText(streamId, ZERO_OFFSET);
    expect(text).toBe("readable-after-close");

    // GET should also indicate the stream is closed
    const getRes = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("Stream-Closed")).toBe("true");
  });
});
