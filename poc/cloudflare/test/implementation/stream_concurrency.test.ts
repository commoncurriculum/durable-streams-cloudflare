import { describe, expect, it } from "vitest";
import { appendStream, createStream, readAllText, uniqueStreamId } from "./helpers";

describe("stream concurrency", () => {
  it("accepts concurrent appends without losing data", async () => {
    const streamId = uniqueStreamId("concurrent");
    await createStream(streamId, "", "text/plain");

    const chunks = Array.from({ length: 12 }, (_, idx) => String.fromCharCode(65 + idx));

    await Promise.all(chunks.map((chunk) => appendStream(streamId, chunk, "text/plain")));

    const text = await readAllText(streamId, "0");

    expect(text.length).toBe(chunks.length);
    const seen = new Set(text.split(""));
    for (const chunk of chunks) {
      expect(seen.has(chunk)).toBe(true);
    }
  });
});
