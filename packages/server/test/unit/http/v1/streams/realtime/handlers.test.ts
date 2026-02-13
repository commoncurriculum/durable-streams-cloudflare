import { describe, it, expect } from "vitest";
import {
  buildSseControlEvent,
  buildSseDataEvent,
  buildWsControlMessage,
  buildWsDataMessage,
  buildLongPollHeaders,
  LongPollQueue,
} from "../../../../../../src/http/v1/streams/realtime/handlers";
import type { StreamMeta } from "../../../../../../src/storage/stream-do";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseMeta = (overrides: Partial<StreamMeta> = {}): StreamMeta => ({
  stream_id: "test-stream",
  content_type: "text/plain",
  closed: 0,
  tail_offset: 100,
  read_seq: 0,
  segment_start: 0,
  segment_messages: 0,
  segment_bytes: 0,
  last_stream_seq: null,
  ttl_seconds: null,
  expires_at: null,
  created_at: Date.now(),
  closed_at: null,
  closed_by_producer_id: null,
  closed_by_epoch: null,
  closed_by_seq: null,
  public: 0,
  ...overrides,
});

const textPayload = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

// ===========================================================================
// LongPollQueue
// ===========================================================================

describe("LongPollQueue", () => {
  it("waitForData resolves false when notified before timeout", async () => {
    const q = new LongPollQueue();
    const promise = q.waitForData(0, "http://x", 5000);
    q.notify(10);
    expect(await promise).toBe(false);
  });

  it("waitForData resolves true on timeout", async () => {
    const q = new LongPollQueue();
    const promise = q.waitForData(0, "http://x", 10);
    expect(await promise).toBe(true);
  });

  it("notify only resolves waiters whose offset < newTail", async () => {
    const q = new LongPollQueue();
    const p1 = q.waitForData(5, "http://a", 10000);
    const p2 = q.waitForData(50, "http://b", 10000);
    q.notify(10); // only p1 (offset 5 < 10)
    expect(await p1).toBe(false);
    // p2 should still be waiting
    expect(q.getWaiterCount()).toBe(1);
    q.notify(100);
    expect(await p2).toBe(false);
  });

  it("notifyAll resolves all waiters", async () => {
    const q = new LongPollQueue();
    const p1 = q.waitForData(0, "http://a", 10000);
    const p2 = q.waitForData(50, "http://b", 10000);
    q.notifyAll();
    expect(await p1).toBe(false);
    expect(await p2).toBe(false);
    expect(q.getWaiterCount()).toBe(0);
  });

  it("getReadyWaiterUrls returns unique URLs below newTail", async () => {
    const q = new LongPollQueue();
    q.waitForData(5, "http://a", 10000);
    q.waitForData(5, "http://a", 10000); // duplicate URL
    q.waitForData(8, "http://b", 10000);
    q.waitForData(50, "http://c", 10000); // above newTail

    const urls = q.getReadyWaiterUrls(10);
    expect(urls).toHaveLength(2);
    expect(urls).toContain("http://a");
    expect(urls).toContain("http://b");
    q.notifyAll(); // cleanup
  });

  it("getWaiterCount tracks current waiters", async () => {
    const q = new LongPollQueue();
    expect(q.getWaiterCount()).toBe(0);
    q.waitForData(0, "http://a", 10000);
    q.waitForData(1, "http://b", 10000);
    expect(q.getWaiterCount()).toBe(2);
    q.notifyAll();
    expect(q.getWaiterCount()).toBe(0);
  });

  it("notify with stagger resolves first waiter immediately", async () => {
    const q = new LongPollQueue();
    const p1 = q.waitForData(0, "http://a", 60000);
    const p2 = q.waitForData(1, "http://b", 60000);

    q.notify(10, 50); // stagger over 50ms

    // First waiter ("scout") resolved immediately
    expect(await p1).toBe(false);

    // Second waiter resolved after stagger delay
    expect(await p2).toBe(false);
  });
});

// ===========================================================================
// buildSseDataEvent
// ===========================================================================

describe("buildSseDataEvent", () => {
  it("formats text payload as SSE data lines", () => {
    const event = buildSseDataEvent(textPayload("hello"), false);
    expect(event).toBe("event: data\ndata:hello\n\n");
  });

  it("splits multi-line text into separate data lines", () => {
    const event = buildSseDataEvent(textPayload("line1\nline2\nline3"), false);
    expect(event).toBe("event: data\ndata:line1\ndata:line2\ndata:line3\n\n");
  });

  it("handles CRLF line endings", () => {
    const event = buildSseDataEvent(textPayload("a\r\nb"), false);
    expect(event).toBe("event: data\ndata:a\ndata:b\n\n");
  });

  it("encodes binary payload as base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const event = buildSseDataEvent(bytes.buffer, true);
    expect(event).toMatch(/^event: data\ndata:/);
    const dataLine = event.split("\n").find((l) => l.startsWith("data:"))!;
    const b64 = dataLine.slice(5);
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect([...decoded]).toEqual([0, 1, 2, 255]);
  });
});

// ===========================================================================
// buildSseControlEvent
// ===========================================================================

describe("buildSseControlEvent", () => {
  it("includes streamCursor and upToDate when not closed", () => {
    const { payload, nextCursor } = buildSseControlEvent({
      nextOffset: "100",
      upToDate: true,
      streamClosed: false,
      cursor: "c1",
    });
    const json = JSON.parse(payload.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
    expect(json.streamNextOffset).toBe("100");
    expect(json.upToDate).toBe(true);
    expect(json.streamCursor).toBeTruthy();
    expect(json.streamClosed).toBeUndefined();
    expect(nextCursor).toBeTruthy();
  });

  it("returns streamClosed and no cursor when closed", () => {
    const { payload, nextCursor } = buildSseControlEvent({
      nextOffset: "100",
      upToDate: false,
      streamClosed: true,
      cursor: "c1",
    });
    const json = JSON.parse(payload.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
    expect(json.streamClosed).toBe(true);
    expect(json.streamCursor).toBeUndefined();
    expect(nextCursor).toBeNull();
  });

  it("includes streamWriteTimestamp when writeTimestamp > 0", () => {
    const { payload } = buildSseControlEvent({
      nextOffset: "abc123",
      upToDate: true,
      streamClosed: false,
      cursor: "c1",
      writeTimestamp: 1707312000000,
    });
    const json = JSON.parse(payload.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
    expect(json.streamWriteTimestamp).toBe(1707312000000);
  });

  it("omits streamWriteTimestamp when writeTimestamp is 0", () => {
    const { payload } = buildSseControlEvent({
      nextOffset: "abc123",
      upToDate: true,
      streamClosed: false,
      cursor: "c1",
      writeTimestamp: 0,
    });
    const json = JSON.parse(payload.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
    expect(json.streamWriteTimestamp).toBeUndefined();
  });
});

// ===========================================================================
// buildLongPollHeaders
// ===========================================================================

describe("buildLongPollHeaders", () => {
  const meta = baseMeta();

  it("sets content-type and next-offset", () => {
    const headers = buildLongPollHeaders({
      meta,
      nextOffsetHeader: "100",
      upToDate: false,
      closedAtTail: false,
      cursor: null,
    });
    expect(headers.get("Content-Type")).toBe("text/plain");
    expect(headers.get("Stream-Next-Offset")).toBe("100");
  });

  it("sets cursor header when provided", () => {
    const headers = buildLongPollHeaders({
      meta,
      nextOffsetHeader: "100",
      upToDate: false,
      closedAtTail: false,
      cursor: "abc",
    });
    expect(headers.get("Stream-Cursor")).toBe("abc");
  });

  it("sets up-to-date header", () => {
    const headers = buildLongPollHeaders({
      meta,
      nextOffsetHeader: "100",
      upToDate: true,
      closedAtTail: false,
      cursor: null,
    });
    expect(headers.get("Stream-Up-To-Date")).toBe("true");
  });

  it("sets closed header", () => {
    const headers = buildLongPollHeaders({
      meta,
      nextOffsetHeader: "100",
      upToDate: false,
      closedAtTail: true,
      cursor: null,
    });
    expect(headers.get("Stream-Closed")).toBe("true");
  });

  it("sets Stream-Write-Timestamp header when writeTimestamp > 0", () => {
    const headers = buildLongPollHeaders({
      meta,
      nextOffsetHeader: "abc123",
      upToDate: true,
      closedAtTail: false,
      cursor: null,
      writeTimestamp: 1707312000000,
    });
    expect(headers.get("Stream-Write-Timestamp")).toBe("1707312000000");
  });

  it("omits Stream-Write-Timestamp header when writeTimestamp is 0", () => {
    const headers = buildLongPollHeaders({
      meta,
      nextOffsetHeader: "abc123",
      upToDate: true,
      closedAtTail: false,
      cursor: null,
      writeTimestamp: 0,
    });
    expect(headers.get("Stream-Write-Timestamp")).toBeNull();
  });
});

// ===========================================================================
// buildWsDataMessage
// ===========================================================================

describe("buildWsDataMessage", () => {
  it("returns text payload for textual content", () => {
    const msg = buildWsDataMessage(textPayload("hello"), false);
    expect(msg.type).toBe("data");
    expect(msg.payload).toBe("hello");
    expect(msg.encoding).toBeUndefined();
  });

  it("returns base64 payload for binary content", () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const msg = buildWsDataMessage(bytes.buffer, true);
    expect(msg.type).toBe("data");
    expect(msg.encoding).toBe("base64");
    const decoded = Uint8Array.from(atob(msg.payload), (c) => c.charCodeAt(0));
    expect([...decoded]).toEqual([0, 1, 2, 255]);
  });
});

// ===========================================================================
// buildWsControlMessage
// ===========================================================================

describe("buildWsControlMessage", () => {
  it("returns cursor and upToDate when not closed", () => {
    const { message, nextCursor } = buildWsControlMessage({
      nextOffset: "100",
      upToDate: true,
      streamClosed: false,
      cursor: "c1",
    });
    expect(message.type).toBe("control");
    expect(message.streamNextOffset).toBe("100");
    expect(message.upToDate).toBe(true);
    expect(message.streamCursor).toBeTruthy();
    expect(message.streamClosed).toBeUndefined();
    expect(nextCursor).toBeTruthy();
  });

  it("returns streamClosed and no cursor when closed", () => {
    const { message, nextCursor } = buildWsControlMessage({
      nextOffset: "100",
      upToDate: false,
      streamClosed: true,
      cursor: "c1",
    });
    expect(message.streamClosed).toBe(true);
    expect(message.streamCursor).toBeUndefined();
    expect(nextCursor).toBeNull();
  });

  it("includes streamWriteTimestamp when writeTimestamp > 0", () => {
    const { message } = buildWsControlMessage({
      nextOffset: "abc123",
      upToDate: true,
      streamClosed: false,
      cursor: "c1",
      writeTimestamp: 1707312000000,
    });
    expect(message.streamWriteTimestamp).toBe(1707312000000);
  });

  it("omits streamWriteTimestamp when writeTimestamp is 0", () => {
    const { message } = buildWsControlMessage({
      nextOffset: "abc123",
      upToDate: true,
      streamClosed: false,
      cursor: "c1",
      writeTimestamp: 0,
    });
    expect(message.streamWriteTimestamp).toBeUndefined();
  });
});
