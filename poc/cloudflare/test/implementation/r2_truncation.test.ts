import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../src/protocol/offsets";
import { createClient, uniqueStreamId } from "./helpers";

describe("R2 truncation handling", () => {
  it("returns an error when a segment is truncated", async () => {
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

    const response = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET }));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toMatch(/segment truncated|segment unavailable|segment missing/);
  });
});
