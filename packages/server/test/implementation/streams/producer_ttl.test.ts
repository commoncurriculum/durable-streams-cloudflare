import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, uniqueStreamId } from "../helpers";

const PRODUCER_HEADERS = {
  "Producer-Id": "producer-ttl",
  "Producer-Epoch": "0",
  "Producer-Seq": "0",
};

describe("producer TTL pruning", () => {
  it("allows producer to restart after TTL expiry", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("producer-ttl");

    await client.createStream(streamId, "", "text/plain");

    const first = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        ...PRODUCER_HEADERS,
      },
      body: "A",
    });

    expect(first.status).toBe(200);

    const age = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Action": "producer-age",
      },
      body: JSON.stringify({
        producerId: PRODUCER_HEADERS["Producer-Id"],
        lastUpdated: Date.now() - 8 * 24 * 60 * 60 * 1000,
      }),
    });

    expect(age.status).toBe(204);

    const second = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        ...PRODUCER_HEADERS,
      },
      body: "B",
    });

    expect(second.status).toBe(200);

    const text = await client.readAllText(streamId, ZERO_OFFSET);
    expect(text).toBe("AB");
  });
});
