import { describe, expect, it } from "vitest";
import { decodeOffsetParts } from "../../src/protocol/offsets";
import { createClient, uniqueStreamId } from "./helpers";

describe("segment rotation", () => {
  it("increments read_seq after compaction", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("rotate");

    await client.createStream(streamId, "", "text/plain");

    const first = await client.appendStream(streamId, "hello", "text/plain");
    const firstOffset = first.headers.get("Stream-Next-Offset");
    const firstParts = firstOffset ? decodeOffsetParts(firstOffset) : null;
    expect(firstParts).not.toBeNull();
    expect(firstParts!.readSeq).toBe(0);

    const compact = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "X-Debug-Action": "compact-retain",
      },
    });
    expect(compact.status).toBe(204);

    const second = await client.appendStream(streamId, "!", "text/plain");
    const secondOffset = second.headers.get("Stream-Next-Offset");
    const secondParts = secondOffset ? decodeOffsetParts(secondOffset) : null;
    expect(secondParts).not.toBeNull();
    expect(secondParts!.readSeq).toBe(1);
    expect(secondParts!.byteOffset).toBe(1);
  });
});
