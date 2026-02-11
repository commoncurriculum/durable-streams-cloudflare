import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../src/http/v1/streams/shared/offsets";
import { createClient, uniqueStreamId, waitForReaderDone } from "./helpers";
import { createPersistDir, getAvailablePort, startWorker } from "./worker_harness";

class SseReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";
  private decoder = new TextDecoder();

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  async nextEvent(timeoutMs: number): Promise<{ event: string; data: string } | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const delimiterIndex = this.buffer.indexOf("\n\n");
      if (delimiterIndex !== -1) {
        const rawEvent = this.buffer.slice(0, delimiterIndex);
        this.buffer = this.buffer.slice(delimiterIndex + 2);
        return this.parseEvent(rawEvent);
      }

      const remaining = deadline - Date.now();
      const result = await Promise.race([
        this.reader.read(),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), remaining)),
      ]);

      if (result === "timeout") return null;
      if (result.done) return null;

      this.buffer += this.decoder.decode(result.value, { stream: true });
    }

    return null;
  }

  async waitForSubstring(substring: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.buffer.includes(substring)) return true;
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        this.reader.read(),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), remaining)),
      ]);
      if (result === "timeout") return false;
      if (result.done) return false;
      this.buffer += this.decoder.decode(result.value, { stream: true });
    }
    return false;
  }

  private parseEvent(rawEvent: string): { event: string; data: string } {
    const lines = rawEvent.split("\n");
    let event = "message";
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice("event:").trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:").trim());
      }
    }

    return { event, data: dataLines.join("\n") };
  }
}

async function waitForSseData(
  reader: SseReader,
  expected: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  return await reader.waitForSubstring(`data:${expected}`, timeoutMs);
}

async function waitForAnySseEvent(reader: SseReader, timeoutMs = 3_000): Promise<boolean> {
  const event = await reader.nextEvent(timeoutMs);
  return event !== null;
}

describe("sse reconnect", () => {
  it("reconnects after worker restart and receives new data", async () => {
    const port = await getAvailablePort();
    const persistDir = await createPersistDir("durable-streams-sse-");

    let worker = await startWorker({ port, persistDir });
    const client = createClient(worker.baseUrl);

    const streamId = uniqueStreamId("sse-restart");
    await client.createStream(streamId, "", "text/plain");

    const appendResponse = await client.appendStream(streamId, "A", "text/plain");
    const afterA = appendResponse.headers.get("Stream-Next-Offset");
    expect(afterA).toBeTruthy();

    const sseResponse = await fetch(
      client.streamUrl(streamId, { live: "sse", offset: ZERO_OFFSET }),
      {
        headers: { Accept: "text/event-stream" },
      },
    );

    expect(sseResponse.status).toBe(200);
    const streamReader = sseResponse.body!.getReader();
    const reader = new SseReader(streamReader);
    const initialEvent = await waitForAnySseEvent(reader, 3_000);
    expect(initialEvent).toBe(true);

    await worker.stop();
    const closed = await waitForReaderDone(streamReader, 1500);
    expect(closed).toBe(true);

    worker = await startWorker({ port, persistDir });
    const restartedClient = createClient(worker.baseUrl);

    const sseResponse2 = await fetch(
      restartedClient.streamUrl(streamId, { live: "sse", offset: afterA! }),
      { headers: { Accept: "text/event-stream" } },
    );

    expect(sseResponse2.status).toBe(200);
    const streamReader2 = sseResponse2.body!.getReader();
    const reader2 = new SseReader(streamReader2);
    const readyEvent = await waitForAnySseEvent(reader2, 3_000);
    expect(readyEvent).toBe(true);

    await restartedClient.appendStream(streamId, "B", "text/plain");

    const received = await waitForSseData(reader2, "B", 4_000);
    expect(received).toBe(true);

    await worker.stop();
  });
});
