import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, uniqueStreamId } from "../helpers";

describe("SSE CRLF handling", () => {
  it("splits CRLF payloads into data lines", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("sse-crlf");

    await client.createStream(streamId, "", "text/plain");
    await client.appendStream(streamId, "line1\r\nline2", "text/plain");

    const response = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }));

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();

    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;

    while (!done && buffer.length < 2000 && !buffer.includes("event: control")) {
      const result = await reader!.read();
      done = result.done;
      if (result.value) {
        buffer += decoder.decode(result.value, { stream: true });
      }
    }

    await reader!.cancel();

    expect(buffer).toContain("event: data\n");
    expect(buffer).toContain("data:line1\n");
    expect(buffer).toContain("data:line2\n");
    expect(buffer).not.toContain("\r");
  });
});
