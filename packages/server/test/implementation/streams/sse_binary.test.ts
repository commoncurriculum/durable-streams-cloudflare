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

/** Decode a base64 string to a Uint8Array. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

describe("SSE binary content (base64 encoding)", () => {
  it(
    "catches up on existing binary data and delivers base64-encoded SSE events",
    { timeout: 15000 },
    async () => {
      const client = createClient();
      const streamId = uniqueStreamId("sse-bin-catchup");

      // Create stream with binary content type and some binary data
      const binaryBody = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello" in ASCII
      await client.createStream(streamId, binaryBody, "application/octet-stream");

      // Connect SSE at ZERO_OFFSET to catch up from the beginning
      const response = await fetch(
        client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");

      // Binary streams should advertise base64 encoding
      expect(response.headers.get("Stream-SSE-Data-Encoding")).toBe("base64");

      // Read until we see the control event (which comes after catch-up data)
      const buffer = await readSseUntil(response, (buf) => buf.includes("event: control"));

      const events = parseSseEvents(buffer);

      // Should have at least one data event and one control event
      const dataEvents = events.filter((e) => e.event === "data");
      const controlEvents = events.filter((e) => e.event === "control");

      expect(dataEvents.length).toBeGreaterThanOrEqual(1);
      expect(controlEvents.length).toBeGreaterThanOrEqual(1);

      // The data event should contain base64-encoded content
      const dataPayload = dataEvents[0].data;
      expect(dataPayload.length).toBeGreaterThan(0);

      // Decode the base64 and verify it matches the original binary
      const decoded = base64ToBytes(dataPayload);
      expect(decoded).toEqual(binaryBody);

      // Control event should have streamNextOffset
      const control = JSON.parse(controlEvents[0].data);
      expect(typeof control.streamNextOffset).toBe("string");
      expect(control.streamNextOffset.length).toBeGreaterThan(0);
    },
  );

  it(
    "broadcasts binary data as base64-encoded SSE events after connect",
    { timeout: 15000 },
    async () => {
      const client = createClient();
      const streamId = uniqueStreamId("sse-bin-broadcast");

      // Create stream with binary content type and empty body
      await client.createStream(streamId, new Uint8Array([]), "application/octet-stream");

      // Connect SSE at ZERO_OFFSET (no catch-up data)
      const response = await fetch(
        client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Stream-SSE-Data-Encoding")).toBe("base64");

      const sse = createSseReader(response);

      // Wait for the initial control event
      await sse.readUntil((buf) => buf.includes("event: control"), 5000);

      // Append binary data after SSE is connected
      const binaryPayload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      await client.appendStream(streamId, binaryPayload, "application/octet-stream");

      // Read until we see a data event from the broadcast
      await sse.readUntil((buf) => {
        const events = parseSseEvents(buf);
        return events.filter((e) => e.event === "data").length > 0;
      }, 5000);

      await sse.cancel();

      const events = parseSseEvents(sse.buffer);
      const dataEvents = events.filter((e) => e.event === "data");

      expect(dataEvents.length).toBeGreaterThanOrEqual(1);

      // The broadcast data event should be base64-encoded
      const broadcastData = dataEvents[0].data;
      expect(broadcastData.length).toBeGreaterThan(0);

      // Decode and verify it matches the appended binary payload
      const decoded = base64ToBytes(broadcastData);
      expect(decoded).toEqual(binaryPayload);
    },
  );

  it(
    "catches up on closed binary stream with base64 data and streamClosed control",
    { timeout: 15000 },
    async () => {
      const client = createClient();
      const streamId = uniqueStreamId("sse-bin-closed");

      // Create stream with binary content type and some data
      const binaryBody = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
      await client.createStream(streamId, binaryBody, "application/octet-stream");

      // Append more binary data
      const appendedData = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
      await client.appendStream(streamId, appendedData, "application/octet-stream");

      // Close the stream (no body, just the header)
      await fetch(client.streamUrl(streamId), {
        method: "POST",
        headers: { "Stream-Closed": "true" },
      });

      // Connect SSE at ZERO_OFFSET to catch up on a closed stream
      const response = await fetch(
        client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Stream-SSE-Data-Encoding")).toBe("base64");

      // Read until we see streamClosed:true in a control event
      const buffer = await readSseUntil(
        response,
        (buf) => buf.includes('"streamClosed":true'),
        10000,
      );

      const events = parseSseEvents(buffer);

      // Should have data events with base64-encoded content
      const dataEvents = events.filter((e) => e.event === "data");
      expect(dataEvents.length).toBeGreaterThanOrEqual(1);

      // Concatenate all data event payloads and decode
      const allBase64 = dataEvents.map((e) => e.data).join("");
      const allDecoded = base64ToBytes(allBase64);

      // The decoded data should contain both the initial body and the appended data
      const expectedCombined = new Uint8Array([...binaryBody, ...appendedData]);
      expect(allDecoded).toEqual(expectedCombined);

      // Should have a control event with streamClosed:true
      const controlEvents = events.filter((e) => e.event === "control");
      expect(controlEvents.length).toBeGreaterThanOrEqual(1);

      const closedControl = controlEvents.find((e) => {
        const parsed = JSON.parse(e.data);
        return parsed.streamClosed === true;
      });
      expect(closedControl).toBeDefined();

      // The closed control event should also have streamNextOffset
      const closedControlData = JSON.parse(closedControl!.data);
      expect(typeof closedControlData.streamNextOffset).toBe("string");
      expect(closedControlData.streamNextOffset.length).toBeGreaterThan(0);
    },
  );
});
