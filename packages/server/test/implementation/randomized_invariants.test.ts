import { describe, expect, it } from "vitest";
import { decodeOffset, encodeOffset } from "../../src/http/v1/streams/shared/offsets";
import { createClient, uniqueStreamId } from "./helpers";

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

function decodeOffsetValue(value: string | null): number {
  if (!value) return 0;
  const decoded = decodeOffset(value);
  if (decoded === null) throw new Error(`Invalid offset: ${value}`);
  return decoded;
}

describe("randomized invariants", () => {
  it("maintains monotonic offsets and data immutability", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("rand");
    await client.createStream(streamId, "", "text/plain");

    let expected = "";
    const rand = seededRandom(0xdeadbeef);
    const iterations = 50;

    for (let i = 0; i < iterations; i += 1) {
      const roll = rand();
      if (roll < 0.65) {
        const len = 1 + Math.floor(rand() * 4);
        const char = String.fromCharCode(97 + Math.floor(rand() * 26));
        const payload = char.repeat(len);
        await client.appendStream(streamId, payload, "text/plain");
        expected += payload;
        continue;
      }

      const offset = Math.floor(rand() * (expected.length + 1));
      const response = await fetch(client.streamUrl(streamId, { offset: encodeOffset(offset) }));
      expect(response.status).toBe(200);
      const body = await response.text();

      const expectedSlice = expected.slice(offset);
      expect(body).toBe(expectedSlice);

      const nextOffsetHeader = response.headers.get("Stream-Next-Offset");
      const nextOffset = decodeOffsetValue(nextOffsetHeader);
      expect(nextOffset).toBe(offset + body.length);
    }
  });
});
