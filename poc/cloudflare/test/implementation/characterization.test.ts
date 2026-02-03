import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../src/protocol/offsets";
import { createClient, uniqueStreamId } from "./helpers";

describe("characterization", () => {
  it("sends a 204 with Stream-Cursor on long-poll timeout", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("char-long-poll");

    await client.createStream(streamId, "", "text/plain");

    const response = await fetch(
      client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "long-poll", cursor: "test" }),
    );

    expect(response.status).toBe(204);
    const cursor = response.headers.get("Stream-Cursor");
    expect(cursor).toBeTruthy();
  });

  it("rejects producer sequence gaps with expected/received headers", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("char-producer-gap");

    await client.createStream(streamId, "", "text/plain");

    const first = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Producer-Id": "producer-gap",
        "Producer-Epoch": "0",
        "Producer-Seq": "0",
      },
      body: "A",
    });

    expect(first.status).toBe(200);

    const gap = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Producer-Id": "producer-gap",
        "Producer-Epoch": "0",
        "Producer-Seq": "2",
      },
      body: "B",
    });

    expect(gap.status).toBe(409);
    expect(gap.headers.get("Producer-Expected-Seq")).toBe("1");
    expect(gap.headers.get("Producer-Received-Seq")).toBe("2");
  });
});
