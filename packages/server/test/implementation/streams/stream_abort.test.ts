import net from "node:net";
import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, delay, uniqueStreamId } from "../helpers";

async function sendTruncatedBody(baseUrl: string, path: string, body: string): Promise<void> {
  const url = new URL(baseUrl);
  const port = url.port ? Number.parseInt(url.port, 10) : 80;
  const host = url.hostname;

  await new Promise<void>((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      const header = [
        `POST ${path} HTTP/1.1`,
        `Host: ${host}`,
        "Content-Type: text/plain",
        `Content-Length: ${body.length + 5}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n");

      socket.write(header);
      socket.write(body);
      setTimeout(() => socket.destroy(), 10);
    });

    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
    setTimeout(() => resolve(), 1000);
  });
}

describe("abort handling", () => {
  it("does not persist partial appends on client abort", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("abort");

    await client.createStream(streamId, "A", "text/plain");

    const url = new URL(client.streamUrl(streamId));
    await sendTruncatedBody(url.origin, url.pathname, "B");
    await delay(500);

    const text = await client.readAllText(streamId, ZERO_OFFSET);
    expect(text).toBe("A");

    await client.appendStream(streamId, "B", "text/plain");
    const finalText = await client.readAllText(streamId, ZERO_OFFSET);
    expect(finalText).toBe("AB");
  });
});
