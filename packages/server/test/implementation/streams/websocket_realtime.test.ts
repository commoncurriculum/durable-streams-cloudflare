import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, delay, uniqueStreamId } from "../helpers";

/**
 * WebSocket realtime handler tests.
 *
 * The SSE endpoint exercises the internal WS bridge:
 * SSE connect → handleWsUpgrade + sendWsCatchUp
 * Appends → broadcastWebSocket / broadcastWebSocketControl
 */

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

/** Read from an SSE response until predicate matches or timeout. Cancels reader when done. */
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

/**
 * Read SSE stream using a persistent reader that accumulates into a mutable buffer object.
 * Use this when you need to read, do something, then continue reading.
 */
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

describe("WebSocket realtime", () => {
  it("catches up on existing data via WS bridge", { timeout: 15000 }, async () => {
    const client = createClient();
    const streamId = uniqueStreamId("ws-catchup");

    await client.createStream(streamId, "hello-ws", "text/plain");

    const response = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    // Wait for a complete control event (event: control\ndata:...\n\n)
    const buffer = await readSseUntil(response, (buf) => {
      const match = buf.match(/event: control\ndata:.+\n/);
      return match !== null;
    });
    const events = parseSseEvents(buffer);

    const dataEvents = events.filter((e) => e.event === "data");
    expect(dataEvents.length).toBeGreaterThanOrEqual(1);
    expect(dataEvents[0].data).toContain("hello-ws");

    const controlEvents = events.filter((e) => e.event === "control");
    expect(controlEvents.length).toBeGreaterThanOrEqual(1);
    const control = JSON.parse(controlEvents[0].data);
    expect(control.streamNextOffset).toBeTruthy();
    expect(control.upToDate).toBe(true);
    expect(control.streamCursor).toBeTruthy();
    expect(control.streamClosed).toBeUndefined();
  });

  it("receives broadcast data+control on append", { timeout: 15000 }, async () => {
    const client = createClient();
    const streamId = uniqueStreamId("ws-broadcast");

    await client.createStream(streamId, "", "text/plain");

    const response = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }));
    expect(response.status).toBe(200);

    const sse = createSseReader(response);
    try {
      // Read initial control event
      await sse.readUntil((buf) => buf.includes("event: control"), 3000);
      const initEvents = parseSseEvents(sse.buffer);
      const initControl = initEvents.find((e) => e.event === "control");
      expect(initControl).toBeTruthy();
      const initControlData = JSON.parse(initControl!.data);
      const initialNextOffset = initControlData.streamNextOffset;

      // Append data — triggers broadcastWebSocket
      await client.appendStream(streamId, "broadcast-payload", "text/plain");

      // Continue reading on the SAME reader
      await sse.readUntil((buf) => buf.includes("broadcast-payload"), 5000);

      const allEvents = parseSseEvents(sse.buffer);
      const broadcastData = allEvents.find(
        (e) => e.event === "data" && e.data.includes("broadcast-payload"),
      );
      expect(broadcastData).toBeTruthy();

      const controlEvents = allEvents.filter((e) => e.event === "control");
      expect(controlEvents.length).toBeGreaterThanOrEqual(2);

      const broadcastControl = JSON.parse(controlEvents[controlEvents.length - 1].data);
      expect(broadcastControl.streamNextOffset).toBeTruthy();
      expect(broadcastControl.streamNextOffset).not.toBe(initialNextOffset);
    } finally {
      await sse.cancel();
    }
  });

  it("receives close notification via broadcastWebSocketControl", { timeout: 15000 }, async () => {
    const client = createClient();
    const streamId = uniqueStreamId("ws-close");

    await client.createStream(streamId, "", "text/plain");

    const response = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }));
    expect(response.status).toBe(200);

    const sse = createSseReader(response);
    try {
      // Read initial control
      await sse.readUntil((buf) => buf.includes("event: control"), 3000);

      // Close the stream (no body) — triggers broadcastWebSocketControl
      await fetch(client.streamUrl(streamId), {
        method: "POST",
        headers: { "Stream-Closed": "true" },
      });

      // Continue reading for close notification
      await sse.readUntil((buf) => buf.includes('"streamClosed":true'), 5000);

      const allEvents = parseSseEvents(sse.buffer);
      const controlEvents = allEvents.filter((e) => e.event === "control");
      expect(controlEvents.length).toBeGreaterThanOrEqual(2);

      const closeControl = controlEvents.find((e) => {
        const parsed = JSON.parse(e.data);
        return parsed.streamClosed === true;
      });
      expect(closeControl).toBeTruthy();

      const closeData = JSON.parse(closeControl!.data);
      expect(closeData.streamClosed).toBe(true);
      expect(closeData.streamNextOffset).toBeTruthy();
      // Closed streams should NOT have a cursor
      expect(closeData.streamCursor).toBeUndefined();
    } finally {
      await sse.cancel();
    }
  });

  it(
    "catch-up on closed stream sends data + streamClosed control",
    { timeout: 15000 },
    async () => {
      const client = createClient();
      const streamId = uniqueStreamId("ws-catchup-closed");

      await client.createStream(streamId, "final-data", "text/plain");
      await fetch(client.streamUrl(streamId), {
        method: "POST",
        headers: { "Stream-Closed": "true" },
      });

      const response = await fetch(
        client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }),
      );
      expect(response.status).toBe(200);

      // readSseUntil is fine here — we only need one read phase
      const buffer = await readSseUntil(
        response,
        (buf) => buf.includes('"streamClosed":true'),
        5000,
      );

      const events = parseSseEvents(buffer);

      const dataEvents = events.filter((e) => e.event === "data");
      expect(dataEvents.length).toBeGreaterThanOrEqual(1);
      expect(dataEvents[0].data).toContain("final-data");

      const closeControl = events.find((e) => {
        if (e.event !== "control") return false;
        const parsed = JSON.parse(e.data);
        return parsed.streamClosed === true;
      });
      expect(closeControl).toBeTruthy();
      const controlData = JSON.parse(closeControl!.data);
      expect(controlData.streamClosed).toBe(true);
    },
  );

  it("append with data and close broadcasts data + close control", { timeout: 15000 }, async () => {
    const client = createClient();
    const streamId = uniqueStreamId("ws-data-close");

    await client.createStream(streamId, "", "text/plain");

    const response = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }));
    expect(response.status).toBe(200);

    const sse = createSseReader(response);
    try {
      // Read initial control
      await sse.readUntil((buf) => buf.includes("event: control"), 3000);

      // Append with close
      await fetch(client.streamUrl(streamId), {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Stream-Closed": "true",
        },
        body: "closing-payload",
      });

      // Continue reading
      await sse.readUntil((buf) => buf.includes('"streamClosed":true'), 5000);

      const allEvents = parseSseEvents(sse.buffer);

      const dataEvent = allEvents.find(
        (e) => e.event === "data" && e.data.includes("closing-payload"),
      );
      expect(dataEvent).toBeTruthy();

      const closeControl = allEvents.find((e) => {
        if (e.event !== "control") return false;
        const parsed = JSON.parse(e.data);
        return parsed.streamClosed === true;
      });
      expect(closeControl).toBeTruthy();
      const controlData = JSON.parse(closeControl!.data);
      expect(controlData.streamClosed).toBe(true);
    } finally {
      await sse.cancel();
    }
  });
});
