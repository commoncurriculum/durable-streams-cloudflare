import { describe, expect, it } from "vitest";
import { ZERO_OFFSET } from "../../../src/http/v1/streams/shared/offsets";
import { createClient, delay, uniqueStreamId } from "../helpers";

// MAX_CHUNK_BYTES in the server is 256 * 1024 = 262,144 bytes.
// To force multi-chunk SSE catch-up, we need total data > 262,144 bytes.
// We'll do multiple appends of ~32 KB each to accumulate ~320 KB total.
const CHUNK_SIZE = 32 * 1024; // 32 KB per append
const APPEND_COUNT = 10; // 10 * 32 KB = 320 KB total > 256 KB chunk limit

function parseSseEvents(buffer: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];
  const blocks = buffer.split(/\n\n/).filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    let eventType = "";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) eventType = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length));
    }
    if (eventType) events.push({ event: eventType, data: dataLines.join("\n") });
  }
  return events;
}

async function readSseUntil(
  response: Response,
  predicate: (buf: string) => boolean,
  timeoutMs = 15000,
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

describe("SSE multi-chunk catch-up", () => {
  it("delivers all data across multiple chunks when total exceeds MAX_CHUNK_BYTES", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("sse-multichunk");

    // Create the stream with text/plain content type
    await client.createStream(streamId, "", "text/plain");

    // Append enough data to exceed the 256 KB chunk limit.
    // Each append is 32 KB of deterministic text so we can verify completeness.
    const appendPayloads: string[] = [];
    for (let i = 0; i < APPEND_COUNT; i++) {
      // Each payload is a unique marker followed by padding to reach ~32 KB.
      const marker = `[CHUNK-${i}]`;
      const padding = "x".repeat(CHUNK_SIZE - marker.length);
      const payload = marker + padding;
      appendPayloads.push(payload);
      await client.appendStream(streamId, payload, "text/plain");
    }

    // Total appended: 10 * 32 KB = 320 KB, which exceeds MAX_CHUNK_BYTES (256 KB).
    // The SSE session should loop reading multiple chunks to catch up.

    // Connect SSE at ZERO_OFFSET to trigger catch-up from the beginning
    const response = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    // Read until we see upToDate:true in a control event
    const buffer = await readSseUntil(response, (buf) => buf.includes('"upToDate":true'));

    const events = parseSseEvents(buffer);

    // Count data and control events
    const dataEvents = events.filter((e) => e.event === "data");
    const controlEvents = events.filter((e) => e.event === "control");

    // We should have MULTIPLE data events — proving multi-chunk reading.
    // With 320 KB total and a 256 KB chunk limit, the SSE session reads
    // one chunk (~256 KB), emits data+control, then loops and reads a
    // second chunk (~64 KB), emitting another data+control.
    expect(dataEvents.length).toBeGreaterThanOrEqual(2);
    expect(controlEvents.length).toBeGreaterThanOrEqual(2);

    // Concatenate all data event payloads
    const allDataReceived = dataEvents.map((e) => e.data).join("");

    // Verify ALL chunk markers arrived
    for (let i = 0; i < APPEND_COUNT; i++) {
      expect(allDataReceived).toContain(`[CHUNK-${i}]`);
    }

    // Verify the total byte count is correct (each append is exactly CHUNK_SIZE bytes)
    const expectedTotalLength = APPEND_COUNT * CHUNK_SIZE;
    expect(allDataReceived.length).toBe(expectedTotalLength);

    // The last control event should have upToDate:true
    const lastControl = controlEvents[controlEvents.length - 1];
    const lastControlData = JSON.parse(lastControl.data);
    expect(lastControlData.upToDate).toBe(true);
  });

  it("intermediate control events have upToDate:false", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("sse-multichunk-intermediate");

    await client.createStream(streamId, "", "text/plain");

    // Append enough data for at least 2 chunks
    for (let i = 0; i < APPEND_COUNT; i++) {
      const marker = `[SEG-${i}]`;
      const padding = "y".repeat(CHUNK_SIZE - marker.length);
      await client.appendStream(streamId, marker + padding, "text/plain");
    }

    const response = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }));
    expect(response.status).toBe(200);

    const buffer = await readSseUntil(response, (buf) => buf.includes('"upToDate":true'));

    const events = parseSseEvents(buffer);
    const controlEvents = events.filter((e) => e.event === "control");

    // We need at least 2 control events for this test to be meaningful
    expect(controlEvents.length).toBeGreaterThanOrEqual(2);

    // All control events except the last should NOT have upToDate:true
    for (let i = 0; i < controlEvents.length - 1; i++) {
      const parsed = JSON.parse(controlEvents[i].data);
      expect(parsed.upToDate).not.toBe(true);
    }

    // The last control event should have upToDate:true
    const lastParsed = JSON.parse(controlEvents[controlEvents.length - 1].data);
    expect(lastParsed.upToDate).toBe(true);
  });

  it("data events arrive in order matching the original append order", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("sse-multichunk-order");

    await client.createStream(streamId, "", "text/plain");

    // Append numbered chunks
    for (let i = 0; i < APPEND_COUNT; i++) {
      const marker = `[ORD-${String(i).padStart(3, "0")}]`;
      const padding = "z".repeat(CHUNK_SIZE - marker.length);
      await client.appendStream(streamId, marker + padding, "text/plain");
    }

    const response = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }));
    expect(response.status).toBe(200);

    const buffer = await readSseUntil(response, (buf) => buf.includes('"upToDate":true'));

    const events = parseSseEvents(buffer);
    const dataEvents = events.filter((e) => e.event === "data");

    // Extract all markers in order from the data events
    const allData = dataEvents.map((e) => e.data).join("");
    const markerPattern = /\[ORD-(\d{3})\]/g;
    const foundMarkers: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = markerPattern.exec(allData)) !== null) {
      foundMarkers.push(Number.parseInt(match[1], 10));
    }

    // All markers should be present
    expect(foundMarkers.length).toBe(APPEND_COUNT);

    // Markers should be in ascending order
    for (let i = 0; i < foundMarkers.length; i++) {
      expect(foundMarkers[i]).toBe(i);
    }
  });

  it("control events carry incrementing streamNextOffset values", async () => {
    const client = createClient();
    const streamId = uniqueStreamId("sse-multichunk-offsets");

    await client.createStream(streamId, "", "text/plain");

    for (let i = 0; i < APPEND_COUNT; i++) {
      const payload = "a".repeat(CHUNK_SIZE);
      await client.appendStream(streamId, payload, "text/plain");
    }

    const response = await fetch(client.streamUrl(streamId, { offset: ZERO_OFFSET, live: "sse" }));
    expect(response.status).toBe(200);

    const buffer = await readSseUntil(response, (buf) => buf.includes('"upToDate":true'));

    const events = parseSseEvents(buffer);
    const controlEvents = events.filter((e) => e.event === "control");

    expect(controlEvents.length).toBeGreaterThanOrEqual(2);

    // Each control event should have a streamNextOffset
    const offsets = controlEvents.map((e) => {
      const parsed = JSON.parse(e.data);
      return parsed.streamNextOffset;
    });

    // All offsets should be defined strings
    for (const offset of offsets) {
      expect(typeof offset).toBe("string");
      expect(offset.length).toBeGreaterThan(0);
    }

    // Offsets should be strictly increasing (lexicographic comparison works
    // because offsets are zero-padded fixed-width strings like "0000000000000001_0000000000032768")
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i] > offsets[i - 1]).toBe(true);
    }
  });
});
