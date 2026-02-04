import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../src/protocol/offsets";
import { createClient, uniqueStreamId } from "./helpers";

type DebugStats = {
  internalReads: number;
};

describe("in-flight read coalescing", () => {
  it("coalesces identical catch-up reads", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("coalesce");

    await client.createStream(streamId, "hello");

    const url = client.streamUrl(streamId, { offset: ZERO_OFFSET });

    const getStats = async (): Promise<DebugStats> => {
      const response = await fetch(url, {
        headers: {
          "X-Debug-Coalesce": "1",
        },
      });
      expect(response.status).toBe(200);
      return (await response.json()) as DebugStats;
    };

    const before = await getStats();

    const [first, second] = await Promise.all([fetch(url), fetch(url)]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await first.arrayBuffer();
    await second.arrayBuffer();

    const after = await getStats();
    expect(after.internalReads - before.internalReads).toBe(1);
  });
});
