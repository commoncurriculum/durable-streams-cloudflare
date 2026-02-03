import { describe, expect, it } from "vitest";
import { createClient, uniqueStreamId } from "./helpers";

describe("R2 truncation fallback", () => {
  it("falls back to D1 when snapshot is truncated", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("r2-truncate");

    await client.createStream(streamId, "", "text/plain");
    await client.appendStream(streamId, "hello", "text/plain");
    await client.appendStream(streamId, "world", "text/plain");

    const compact = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "X-Debug-Action": "compact-retain",
      },
    });
    expect(compact.status).toBe(204);

    const truncate = await fetch(client.streamUrl(streamId), {
      method: "POST",
      headers: {
        "X-Debug-Action": "truncate-latest",
      },
    });
    expect(truncate.status).toBe(204);

    const text = await client.readAllText(streamId, "0");
    expect(text).toBe("helloworld");
  });
});
