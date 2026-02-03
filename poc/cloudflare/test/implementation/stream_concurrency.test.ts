import { describe, expect, it } from "vitest";
import { createClient, uniqueStreamId } from "./helpers";

describe("stream concurrency", () => {
  it("accepts concurrent appends without losing data", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("concurrent");
    await client.createStream(streamId, "", "text/plain");

    const chunks = Array.from({ length: 12 }, (_, idx) => String.fromCharCode(65 + idx));

    await Promise.all(chunks.map((chunk) => client.appendStream(streamId, chunk, "text/plain")));

    const text = await client.readAllText(streamId, "0");

    expect(text.length).toBe(chunks.length);
    const seen = new Set(text.split(""));
    for (const chunk of chunks) {
      expect(seen.has(chunk)).toBe(true);
    }
  });
});
