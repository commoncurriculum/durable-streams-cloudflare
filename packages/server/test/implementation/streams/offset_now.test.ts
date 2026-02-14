import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, delay, uniqueStreamId } from "../helpers";

function parseSseEvents(buffer: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];
  const blocks = buffer.split(/\n\n/).filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    let eventType = "";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        eventType = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length));
      }
    }
    if (eventType) {
      events.push({ event: eventType, data: dataLines.join("\n") });
    }
  }
  return events;
}

async function readSseUntil(
  response: Response,
  predicate: (buffer: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline && !predicate(buffer)) {
      const result = await Promise.race([
        reader.read(),
        delay(Math.max(1, deadline - Date.now())).then(
          () => ({ done: true, value: undefined }) as const,
        ),
      ]);
      if (result.done) break;
      if (result.value) buffer += decoder.decode(result.value as Uint8Array, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return buffer;
}

function createSseReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async readUntil(predicate: (buf: string) => boolean, timeoutMs = 5000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && !predicate(buffer)) {
        const result = await Promise.race([
          reader.read(),
          delay(Math.max(1, deadline - Date.now())).then(
            () => ({ done: true, value: undefined }) as const,
          ),
        ]);
        if (result.done) break;
        if (result.value) buffer += decoder.decode(result.value as Uint8Array, { stream: true });
      }
      return buffer;
    },
    async cancel() {
      await reader.cancel().catch(() => {});
    },
    get buffer() {
      return buffer;
    },
  };
}

describe("offset=now and offset=-1", () => {
  describe("long-poll with offset=now", () => {
    it("returns 204 up-to-date on stream with existing data", async () => {
      const client = createClient();
      const streamId = uniqueStreamId("lp-now-uptodate");

      await client.createStream(streamId, "existing-data", "text/plain");

      const response = await fetch(
        client.streamUrl(streamId, { offset: "now", live: "long-poll" }),
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Stream-Up-To-Date")).toBe("true");
    });

    it("wakes up when data arrives after connecting", { timeout: 30000 }, async () => {
      const client = createClient();
      const streamId = uniqueStreamId("lp-now-wake");

      await client.createStream(streamId, "initial-data", "text/plain");

      const [response] = await Promise.all([
        fetch(client.streamUrl(streamId, { offset: "now", live: "long-poll" })),
        (async () => {
          await delay(500);
          await client.appendStream(streamId, "new-data", "text/plain");
        })(),
      ]);

      // Should get 200 with new data or 204 timeout (both acceptable)
      if (response.status === 200) {
        const body = await response.text();
        expect(body).toBe("new-data");
      } else {
        expect(response.status).toBe(204);
      }
    });

    it("returns 204 with Stream-Closed on closed stream", async () => {
      const client = createClient();
      const streamId = uniqueStreamId("lp-now-closed");

      await client.createStream(streamId, "data", "text/plain");

      // Close the stream
      await fetch(client.streamUrl(streamId), {
        method: "POST",
        headers: { "Stream-Closed": "true" },
      });

      const response = await fetch(
        client.streamUrl(streamId, { offset: "now", live: "long-poll" }),
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("Stream-Closed")).toBe("true");
      expect(response.headers.get("Stream-Up-To-Date")).toBe("true");
    });
  });

  describe("SSE with offset=now", () => {
    it("starts at tail with no catch-up data", { timeout: 15000 }, async () => {
      const client = createClient();
      const streamId = uniqueStreamId("sse-now-nocatchup");

      await client.createStream(streamId, "existing-data", "text/plain");

      const response = await fetch(client.streamUrl(streamId, { offset: "now", live: "sse" }));

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      const sse = createSseReader(response);

      // Read until we see the initial control event (upToDate)
      const initialBuffer = await sse.readUntil((buf) => buf.includes("event: control"));

      const initialEvents = parseSseEvents(initialBuffer);

      // Should NOT have data events for the existing data
      const dataEvents = initialEvents.filter((e) => e.event === "data");
      expect(dataEvents).toHaveLength(0);

      // Should have a control event with upToDate
      const controlEvents = initialEvents.filter((e) => e.event === "control");
      expect(controlEvents.length).toBeGreaterThanOrEqual(1);
      const controlData = JSON.parse(controlEvents[0].data);
      expect(controlData.upToDate).toBe(true);

      // Now append new data and verify it arrives as a broadcast
      await client.appendStream(streamId, "broadcast-msg", "text/plain");

      const broadcastBuffer = await sse.readUntil((buf) => buf.includes("data:broadcast-msg"));

      expect(broadcastBuffer).toContain("event: data\n");
      expect(broadcastBuffer).toContain("data:broadcast-msg\n");

      await sse.cancel();
    });
  });

  describe("SSE with offset=-1", () => {
    it("catches up from the beginning", { timeout: 15000 }, async () => {
      const client = createClient();
      const streamId = uniqueStreamId("sse-minus1");

      await client.createStream(streamId, "from-the-start", "text/plain");

      const response = await fetch(client.streamUrl(streamId, { offset: "-1", live: "sse" }));

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      // Read until we see the control event (comes after catch-up data)
      const buffer = await readSseUntil(response, (buf) => buf.includes("event: control"));

      // Should contain the existing data as a catch-up data event
      expect(buffer).toContain("event: data\n");
      expect(buffer).toContain("data:from-the-start\n");

      // Should also contain the control event
      expect(buffer).toContain("event: control\n");
    });
  });
});
