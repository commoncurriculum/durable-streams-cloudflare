import { describe, expect, it } from "vitest";
import { encodeOffset } from "../../src/protocol/offsets";
import { createClient, uniqueStreamId } from "./helpers";

describe("segment boundary alignment", () => {
  it("serves reads across multiple segments", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("segment");

    await client.createStream(streamId, "", "text/plain");

    for (let i = 0; i < 1200; i += 1) {
      await client.appendStream(streamId, "x", "text/plain");
    }

    const compact = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "X-Debug-Action": "compact-retain",
      },
    });
    expect(compact.status).toBe(204);

    for (let i = 0; i < 1200; i += 1) {
      await client.appendStream(streamId, "y", "text/plain");
    }

    const compact2 = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "X-Debug-Action": "compact-retain",
      },
    });
    expect(compact2.status).toBe(204);

    const response = await fetch(client.streamUrl(streamId, { offset: encodeOffset(1000) }));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe(`${"x".repeat(200)}${"y".repeat(1200)}`);
  });
});
