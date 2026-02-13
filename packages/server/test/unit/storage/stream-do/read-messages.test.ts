import { describe, it, expect } from "vitest";
import { readFromMessages } from "../../../../src/storage/stream-do/read-messages";

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (buf: ArrayBuffer) => new TextDecoder().decode(buf);

describe("readFromMessages (binary)", () => {
  it("reads a single message from the start", () => {
    const result = readFromMessages({
      messages: [encode("hello")],
      contentType: "text/plain",
      offset: 0,
      maxChunkBytes: 1024,
      tailOffset: 5,
      closed: false,
    });

    expect(result.hasData).toBe(true);
    expect(decode(result.body)).toBe("hello");
    expect(result.nextOffset).toBe(5);
    expect(result.upToDate).toBe(true);
  });

  it("reads multiple messages concatenated", () => {
    const result = readFromMessages({
      messages: [encode("abc"), encode("def")],
      contentType: "text/plain",
      offset: 0,
      maxChunkBytes: 1024,
      tailOffset: 6,
      closed: false,
    });

    expect(result.hasData).toBe(true);
    expect(decode(result.body)).toBe("abcdef");
    expect(result.nextOffset).toBe(6);
  });

  it("skips messages before the offset", () => {
    const result = readFromMessages({
      messages: [encode("abc"), encode("def")],
      contentType: "text/plain",
      offset: 3, // skip "abc"
      maxChunkBytes: 1024,
      tailOffset: 6,
      closed: false,
    });

    expect(result.hasData).toBe(true);
    expect(decode(result.body)).toBe("def");
    expect(result.nextOffset).toBe(6);
  });

  it("returns empty when offset is at tail", () => {
    const result = readFromMessages({
      messages: [encode("abc")],
      contentType: "text/plain",
      offset: 3,
      maxChunkBytes: 1024,
      tailOffset: 3,
      closed: false,
    });

    expect(result.hasData).toBe(false);
    expect(result.upToDate).toBe(true);
  });

  it("sets closedAtTail when stream is closed and at tail", () => {
    const result = readFromMessages({
      messages: [encode("abc")],
      contentType: "text/plain",
      offset: 3,
      maxChunkBytes: 1024,
      tailOffset: 3,
      closed: true,
    });

    expect(result.hasData).toBe(false);
    expect(result.closedAtTail).toBe(true);
  });
});

describe("readFromMessages (JSON)", () => {
  it("reads JSON messages from the start", () => {
    const msg1 = encode('{"a":1}');
    const msg2 = encode('{"b":2}');

    const result = readFromMessages({
      messages: [msg1, msg2],
      contentType: "application/json",
      offset: 0,
      maxChunkBytes: 1024,
      tailOffset: 2,
      closed: false,
    });

    expect(result.hasData).toBe(true);
    const parsed = JSON.parse(decode(result.body));
    expect(parsed).toEqual([{ a: 1 }, { b: 2 }]);
    expect(result.nextOffset).toBe(2);
    expect(result.upToDate).toBe(true);
  });

  it("reads JSON messages from a non-zero offset", () => {
    const msg1 = encode('{"a":1}');
    const msg2 = encode('{"b":2}');
    const msg3 = encode('{"c":3}');

    const result = readFromMessages({
      messages: [msg1, msg2, msg3],
      contentType: "application/json",
      offset: 1,
      maxChunkBytes: 1024,
      tailOffset: 3,
      closed: false,
    });

    expect(result.hasData).toBe(true);
    const parsed = JSON.parse(decode(result.body));
    expect(parsed).toEqual([{ b: 2 }, { c: 3 }]);
    expect(result.nextOffset).toBe(3);
  });

  it("returns empty JSON array when offset is at end", () => {
    const msg1 = encode('{"a":1}');

    const result = readFromMessages({
      messages: [msg1],
      contentType: "application/json",
      offset: 1,
      maxChunkBytes: 1024,
      tailOffset: 1,
      closed: false,
    });

    expect(result.hasData).toBe(false);
    expect(result.upToDate).toBe(true);
    // Empty body should be a valid JSON array
    const body = decode(result.body);
    expect(JSON.parse(body)).toEqual([]);
  });

  it("respects segmentStart for relative offset calculation", () => {
    const msg1 = encode('{"a":1}');
    const msg2 = encode('{"b":2}');

    const result = readFromMessages({
      messages: [msg1, msg2],
      contentType: "application/json",
      offset: 11, // segmentStart=10, so relative offset = 1
      maxChunkBytes: 1024,
      tailOffset: 12,
      closed: false,
      segmentStart: 10,
    });

    expect(result.hasData).toBe(true);
    const parsed = JSON.parse(decode(result.body));
    expect(parsed).toEqual([{ b: 2 }]);
    expect(result.nextOffset).toBe(12);
  });
});
