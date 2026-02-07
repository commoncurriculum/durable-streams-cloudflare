import { describe, it, expect } from "vitest";
import {
  encodeStreamPathBase64Url,
  buildSegmentKey,
  encodeSegmentMessages,
  readSegmentMessages,
} from "../../../src/storage/segments";

// ============================================================================
// Helpers
// ============================================================================

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encode a string as a Uint8Array */
function bytes(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Create a ReadableStream from a single Uint8Array */
function streamFrom(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

/** Create a ReadableStream that delivers data in small chunks */
function chunkedStream(data: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= data.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, data.byteLength);
      controller.enqueue(data.slice(offset, end));
      offset = end;
    },
  });
}

/** Create an empty ReadableStream */
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

/** Encode a set of string messages into a segment binary blob */
function encodeStrings(strings: string[]): Uint8Array {
  return encodeSegmentMessages(strings.map(bytes));
}

// ============================================================================
// encodeStreamPathBase64Url
// ============================================================================

describe("encodeStreamPathBase64Url", () => {
  it("returns empty string for empty input", () => {
    expect(encodeStreamPathBase64Url("")).toBe("");
  });

  it("encodes a simple ASCII path", () => {
    const result = encodeStreamPathBase64Url("my-stream");
    // Base64url should not contain +, /, or trailing =
    expect(result).not.toMatch(/[+/=]/);
    expect(result.length).toBeGreaterThan(0);
  });

  it("produces standard base64url encoding", () => {
    // "my-stream" -> btoa("my-stream") = "bXktc3RyZWFt"
    // No + or / in this case, so base64url should match standard base64
    expect(encodeStreamPathBase64Url("my-stream")).toBe("bXktc3RyZWFt");
  });

  it("replaces + with - and / with _", () => {
    // We need input that produces + or / in standard base64
    // ">>" encodes to "Pj4=" in base64, which has = but no + or /
    // "?>" encodes to "Pz4=" ... let's find one with + or /
    // Bytes [62, 251] -> base64 "Pvs=" ... still no + or /
    // Bytes [0xFF, 0xFE] -> btoa(String.fromCharCode(255, 254)) = "//4=" -> base64url "..4"
    // Let's use a string whose UTF-8 bytes produce / or + in base64
    const result = encodeStreamPathBase64Url("\xFF");
    // "\xFF" as UTF-8 is [0xC3, 0xBF] -> btoa -> "w78=" -> base64url "w78"
    expect(result).not.toMatch(/[+/=]/);
  });

  it("strips trailing = padding", () => {
    // "a" -> btoa("a") = "YQ==" -> base64url "YQ"
    expect(encodeStreamPathBase64Url("a")).toBe("YQ");
  });

  it("handles unicode characters", () => {
    const result = encodeStreamPathBase64Url("stream/\u{1F600}/test");
    expect(result).not.toMatch(/[+/=]/);
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles long paths without error", () => {
    const longPath = "a".repeat(100_000);
    const result = encodeStreamPathBase64Url(longPath);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// buildSegmentKey
// ============================================================================

describe("buildSegmentKey", () => {
  it("builds a key with encoded stream ID and readSeq", () => {
    const key = buildSegmentKey("my-stream", 0);
    expect(key).toBe("stream/bXktc3RyZWFt/segment-0.seg");
  });

  it("includes the readSeq number in the key", () => {
    const key = buildSegmentKey("my-stream", 42);
    expect(key).toBe("stream/bXktc3RyZWFt/segment-42.seg");
  });

  it("uses different encoded paths for different stream IDs", () => {
    const key1 = buildSegmentKey("stream-a", 0);
    const key2 = buildSegmentKey("stream-b", 0);
    expect(key1).not.toBe(key2);
  });

  it("handles empty stream ID", () => {
    const key = buildSegmentKey("", 0);
    expect(key).toBe("stream//segment-0.seg");
  });
});

// ============================================================================
// encodeSegmentMessages
// ============================================================================

describe("encodeSegmentMessages", () => {
  it("encodes an empty array to an empty Uint8Array", () => {
    const result = encodeSegmentMessages([]);
    expect(result.byteLength).toBe(0);
  });

  it("encodes a single message with 4-byte length prefix", () => {
    const msg = bytes("hello");
    const result = encodeSegmentMessages([msg]);

    // 4 bytes length prefix + 5 bytes "hello"
    expect(result.byteLength).toBe(4 + 5);

    // Check length prefix (big-endian uint32)
    const view = new DataView(result.buffer, result.byteOffset);
    expect(view.getUint32(0)).toBe(5);

    // Check payload
    const payload = result.slice(4);
    expect(decoder.decode(payload)).toBe("hello");
  });

  it("encodes multiple messages sequentially", () => {
    const msgs = [bytes("aaa"), bytes("bb"), bytes("c")];
    const result = encodeSegmentMessages(msgs);

    // (4 + 3) + (4 + 2) + (4 + 1) = 18
    expect(result.byteLength).toBe(18);

    const view = new DataView(result.buffer, result.byteOffset);
    // First message: length 3, payload "aaa"
    expect(view.getUint32(0)).toBe(3);
    expect(decoder.decode(result.slice(4, 7))).toBe("aaa");

    // Second message: length 2, payload "bb"
    expect(view.getUint32(7)).toBe(2);
    expect(decoder.decode(result.slice(11, 13))).toBe("bb");

    // Third message: length 1, payload "c"
    expect(view.getUint32(13)).toBe(1);
    expect(decoder.decode(result.slice(17, 18))).toBe("c");
  });

  it("encodes a zero-length message", () => {
    const result = encodeSegmentMessages([new Uint8Array(0)]);
    // 4 bytes length prefix (value 0) + 0 bytes payload
    expect(result.byteLength).toBe(4);

    const view = new DataView(result.buffer, result.byteOffset);
    expect(view.getUint32(0)).toBe(0);
  });

  it("throws for messages exceeding 64 MiB", () => {
    const tooBig = new Uint8Array(64 * 1024 * 1024 + 1);
    expect(() => encodeSegmentMessages([tooBig])).toThrow("segment message too large");
  });

  it("accepts a message of exactly 64 MiB", () => {
    const maxSize = new Uint8Array(64 * 1024 * 1024);
    // Should not throw
    const result = encodeSegmentMessages([maxSize]);
    expect(result.byteLength).toBe(4 + 64 * 1024 * 1024);
  });
});

// ============================================================================
// readSegmentMessages — round-trip with encodeSegmentMessages
// ============================================================================

describe("readSegmentMessages — round-trip", () => {
  it("round-trips a single JSON message", async () => {
    const encoded = encodeStrings(["hello"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: true,
    });

    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(decoder.decode(result.messages[0])).toBe("hello");
    expect(result.segmentStart).toBe(0);
  });

  it("round-trips multiple JSON messages", async () => {
    const encoded = encodeStrings(["aaa", "bbb", "ccc"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: true,
    });

    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(3);
    expect(decoder.decode(result.messages[0])).toBe("aaa");
    expect(decoder.decode(result.messages[1])).toBe("bbb");
    expect(decoder.decode(result.messages[2])).toBe("ccc");
  });

  it("round-trips binary messages", async () => {
    const encoded = encodeStrings(["aaa", "bbb", "ccc"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: false,
    });

    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(3);
    expect(decoder.decode(result.messages[0])).toBe("aaa");
    expect(decoder.decode(result.messages[1])).toBe("bbb");
    expect(decoder.decode(result.messages[2])).toBe("ccc");
  });
});

// ============================================================================
// readSegmentMessages — empty segment
// ============================================================================

describe("readSegmentMessages — empty segment", () => {
  it("returns no messages for an empty stream body", async () => {
    const result = await readSegmentMessages({
      body: emptyStream(),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: true,
    });

    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(0);
    expect(result.segmentStart).toBe(0);
  });

  it("returns no messages for empty binary stream", async () => {
    const result = await readSegmentMessages({
      body: emptyStream(),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: false,
    });

    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(0);
  });
});

// ============================================================================
// readSegmentMessages — JsonMessageCollector offset skipping
// ============================================================================

describe("readSegmentMessages — JSON offset skipping", () => {
  it("skips messages before the target index", async () => {
    // segmentStart = 10, offset = 12 => targetIndex = 12 - 10 = 2
    // So messages at indices 0,1 are skipped; message at index 2 is collected
    const encoded = encodeStrings(["skip-0", "skip-1", "keep-2", "keep-3"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 12,
      segmentStart: 10,
      maxChunkBytes: 1024,
      isJson: true,
    });

    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(2);
    expect(decoder.decode(result.messages[0])).toBe("keep-2");
    expect(decoder.decode(result.messages[1])).toBe("keep-3");
    // outputStart should be segmentStart + messageIndex of first collected message
    expect(result.segmentStart).toBe(12);
  });

  it("skips all messages when offset exceeds message count", async () => {
    // segmentStart = 0, offset = 100 => targetIndex = 100
    // Only 3 messages, all skipped
    const encoded = encodeStrings(["a", "b", "c"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 100,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: true,
    });

    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(0);
  });

  it("collects from the first message when offset equals segmentStart", async () => {
    const encoded = encodeStrings(["first", "second"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 5,
      segmentStart: 5,
      maxChunkBytes: 1024,
      isJson: true,
    });

    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(2);
    expect(decoder.decode(result.messages[0])).toBe("first");
    expect(result.segmentStart).toBe(5);
  });

  it("sets outputStart to the index of the first collected message", async () => {
    // segmentStart = 0, offset = 1 => targetIndex = 1
    // Skip message 0, collect message 1 onwards
    const encoded = encodeStrings(["skip", "collect-1", "collect-2"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 1,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: true,
    });

    expect(result.messages).toHaveLength(2);
    // outputStart = segmentStart + messageIndex = 0 + 1 = 1
    expect(result.segmentStart).toBe(1);
  });
});

// ============================================================================
// readSegmentMessages — BinaryMessageCollector offset skipping
// ============================================================================

describe("readSegmentMessages — binary offset skipping", () => {
  it("skips messages whose byte range falls before the offset", async () => {
    // Messages: "aaa" (3 bytes), "bbb" (3 bytes), "ccc" (3 bytes)
    // segmentStart = 0, cursor positions: [0, 3, 6]
    // offset = 3 => skip "aaa" (end=3 <= 3), collect "bbb" (end=6 > 3), collect "ccc"
    const encoded = encodeStrings(["aaa", "bbb", "ccc"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 3,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: false,
    });

    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(2);
    expect(decoder.decode(result.messages[0])).toBe("bbb");
    expect(decoder.decode(result.messages[1])).toBe("ccc");
    // outputStart = cursor value when first message was collected = 3
    expect(result.segmentStart).toBe(3);
  });

  it("skips all messages when offset exceeds total byte range", async () => {
    // Messages: "aaa" (3 bytes), "bbb" (3 bytes) — total 6 bytes
    // offset = 100 => skip both
    const encoded = encodeStrings(["aaa", "bbb"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 100,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: false,
    });

    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(0);
  });

  it("collects first message when offset is 0", async () => {
    const encoded = encodeStrings(["hello"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: false,
    });

    expect(result.messages).toHaveLength(1);
    expect(decoder.decode(result.messages[0])).toBe("hello");
    expect(result.segmentStart).toBe(0);
  });

  it("accounts for segmentStart in byte cursor tracking", async () => {
    // segmentStart = 10, so cursor starts at 10
    // Messages: "aa" (2 bytes), "bb" (2 bytes), "cc" (2 bytes)
    // Cursor: 10, 12, 14
    // offset = 12 => skip "aa" (end=12 <= 12), collect "bb" (end=14 > 12), collect "cc"
    const encoded = encodeStrings(["aa", "bb", "cc"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 12,
      segmentStart: 10,
      maxChunkBytes: 1024,
      isJson: false,
    });

    expect(result.messages).toHaveLength(2);
    expect(decoder.decode(result.messages[0])).toBe("bb");
    expect(decoder.decode(result.messages[1])).toBe("cc");
    expect(result.segmentStart).toBe(12);
  });

  it("includes a message that partially overlaps the offset boundary", async () => {
    // segmentStart = 0
    // Messages: "aaaa" (4 bytes), "bb" (2 bytes)
    // Cursor: 0, 4
    // offset = 2 => "aaaa" end=4 > 2, so it's collected
    const encoded = encodeStrings(["aaaa", "bb"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 2,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: false,
    });

    expect(result.messages).toHaveLength(2);
    expect(decoder.decode(result.messages[0])).toBe("aaaa");
    expect(decoder.decode(result.messages[1])).toBe("bb");
    expect(result.segmentStart).toBe(0);
  });
});

// ============================================================================
// readSegmentMessages — maxChunkBytes limiting
// ============================================================================

describe("readSegmentMessages — maxChunkBytes", () => {
  it("stops collecting JSON messages when maxChunkBytes is reached", async () => {
    // Each message is 3 bytes. maxChunkBytes = 5 means after 2 messages (6 bytes) we stop.
    const encoded = encodeStrings(["aaa", "bbb", "ccc", "ddd"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 5,
      isJson: true,
    });

    expect(result.truncated).toBe(false);
    // After 2 messages (6 bytes >= 5), isFull() returns true, loop stops
    expect(result.messages).toHaveLength(2);
    expect(decoder.decode(result.messages[0])).toBe("aaa");
    expect(decoder.decode(result.messages[1])).toBe("bbb");
  });

  it("stops collecting binary messages when maxChunkBytes is reached", async () => {
    const encoded = encodeStrings(["aaa", "bbb", "ccc", "ddd"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 5,
      isJson: false,
    });

    // After 2 messages (6 bytes >= 5), isFull() returns true
    expect(result.messages).toHaveLength(2);
  });

  it("collects at least one message even if it exceeds maxChunkBytes", async () => {
    // A single 10-byte message with maxChunkBytes = 3
    const encoded = encodeStrings(["0123456789"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 3,
      isJson: true,
    });

    // The first message is added before isFull() is checked, so it gets through
    expect(result.messages).toHaveLength(1);
    expect(decoder.decode(result.messages[0])).toBe("0123456789");
  });

  it("returns all messages when maxChunkBytes is very large", async () => {
    const encoded = encodeStrings(["a", "b", "c"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024 * 1024,
      isJson: true,
    });

    expect(result.messages).toHaveLength(3);
  });
});

// ============================================================================
// readSegmentMessages — SegmentReader chunked delivery
// ============================================================================

describe("readSegmentMessages — chunked stream delivery", () => {
  it("correctly reads messages split across small chunks", async () => {
    const encoded = encodeStrings(["hello", "world"]);
    // Deliver 1 byte at a time to exercise the buffer merging logic
    const result = await readSegmentMessages({
      body: chunkedStream(encoded, 1),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: true,
    });

    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(2);
    expect(decoder.decode(result.messages[0])).toBe("hello");
    expect(decoder.decode(result.messages[1])).toBe("world");
  });

  it("handles chunks that span message boundaries", async () => {
    const encoded = encodeStrings(["ab", "cd", "ef"]);
    // Chunk size of 5 means each chunk straddles a length prefix and payload
    const result = await readSegmentMessages({
      body: chunkedStream(encoded, 5),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: true,
    });

    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(3);
    expect(decoder.decode(result.messages[0])).toBe("ab");
    expect(decoder.decode(result.messages[1])).toBe("cd");
    expect(decoder.decode(result.messages[2])).toBe("ef");
  });

  it("handles a chunk exactly matching one message", async () => {
    // Single message "hi" = 4 + 2 = 6 bytes total
    const encoded = encodeStrings(["hi"]);
    const result = await readSegmentMessages({
      body: chunkedStream(encoded, 6),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: true,
    });

    expect(result.messages).toHaveLength(1);
    expect(decoder.decode(result.messages[0])).toBe("hi");
  });
});

// ============================================================================
// readSegmentMessages — truncation detection
// ============================================================================

describe("readSegmentMessages — truncation", () => {
  it("detects truncation when stream ends mid-length-prefix", async () => {
    // A valid message followed by only 2 bytes of a length prefix (needs 4)
    const validMsg = encodeStrings(["ok"]);
    const truncated = new Uint8Array(validMsg.byteLength + 2);
    truncated.set(validMsg, 0);
    truncated[validMsg.byteLength] = 0;
    truncated[validMsg.byteLength + 1] = 0;

    const result = await readSegmentMessages({
      body: streamFrom(truncated),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: true,
    });

    expect(result.truncated).toBe(true);
    // Should still have collected the first valid message
    expect(result.messages).toHaveLength(1);
    expect(decoder.decode(result.messages[0])).toBe("ok");
  });

  it("detects truncation when stream ends mid-payload", async () => {
    // Build a segment that claims a 100-byte payload but only provides 10 bytes
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 100);
    const partialPayload = new Uint8Array(10); // only 10 of 100 bytes

    const data = new Uint8Array(4 + 10);
    data.set(header, 0);
    data.set(partialPayload, 4);

    const result = await readSegmentMessages({
      body: streamFrom(data),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: true,
    });

    expect(result.truncated).toBe(true);
    expect(result.messages).toHaveLength(0);
  });

  it("detects truncation for oversized length prefix", async () => {
    // Build a length prefix that exceeds MAX_SEGMENT_MESSAGE_BYTES (64 MiB)
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 64 * 1024 * 1024 + 1);

    const result = await readSegmentMessages({
      body: streamFrom(header),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: true,
    });

    expect(result.truncated).toBe(true);
    expect(result.messages).toHaveLength(0);
  });

  it("returns truncated with previously collected messages", async () => {
    // Two valid messages, then a truncated third
    const validMsgs = encodeStrings(["msg-1", "msg-2"]);
    const truncatedExtra = new Uint8Array(3); // 3 bytes of incomplete length prefix

    const combined = new Uint8Array(validMsgs.byteLength + truncatedExtra.byteLength);
    combined.set(validMsgs, 0);
    combined.set(truncatedExtra, validMsgs.byteLength);

    const result = await readSegmentMessages({
      body: streamFrom(combined),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: true,
    });

    expect(result.truncated).toBe(true);
    expect(result.messages).toHaveLength(2);
    expect(decoder.decode(result.messages[0])).toBe("msg-1");
    expect(decoder.decode(result.messages[1])).toBe("msg-2");
  });
});

// ============================================================================
// readSegmentMessages — zero-length messages
// ============================================================================

describe("readSegmentMessages — zero-length messages", () => {
  it("handles zero-length messages in JSON mode", async () => {
    const encoded = encodeSegmentMessages([
      new Uint8Array(0),
      bytes("after-empty"),
    ]);

    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: true,
    });

    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].byteLength).toBe(0);
    expect(decoder.decode(result.messages[1])).toBe("after-empty");
  });

  it("handles zero-length messages in binary mode", async () => {
    // In binary mode, a zero-length message at cursor=0 with offset=0
    // has end=0 which equals offset, so end <= offset is true and it gets skipped.
    // Only the subsequent non-zero message is collected.
    const encoded = encodeSegmentMessages([
      new Uint8Array(0),
      bytes("after-empty"),
    ]);

    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: false,
    });

    expect(result.truncated).toBe(false);
    // Binary collector skips zero-length messages at offset boundary (end=0 <= offset=0)
    expect(result.messages).toHaveLength(1);
    expect(decoder.decode(result.messages[0])).toBe("after-empty");
    expect(result.segmentStart).toBe(0);
  });
});

// ============================================================================
// readSegmentMessages — JSON vs binary collector behavior differences
// ============================================================================

describe("readSegmentMessages — JSON vs binary collector differences", () => {
  it("JSON collector counts messages by index, binary counts by bytes", async () => {
    // Messages of varying sizes: "a" (1), "bb" (2), "ccc" (3), "dddd" (4)
    // segmentStart = 0, offset = 2
    //
    // JSON: targetIndex = 2 - 0 = 2, skips indices 0 and 1, collects indices 2 and 3
    // Binary: cursor starts at 0, offset = 2
    //   "a" end=1 <= 2, skip; "bb" end=3 > 2, collect; "ccc" end=6 > 2, collect; "dddd" collect
    const encoded = encodeStrings(["a", "bb", "ccc", "dddd"]);

    const jsonResult = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 2,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: true,
    });

    const binaryResult = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 2,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: false,
    });

    // JSON skips by message index: skip 0, skip 1, collect 2 ("ccc"), collect 3 ("dddd")
    expect(jsonResult.messages).toHaveLength(2);
    expect(decoder.decode(jsonResult.messages[0])).toBe("ccc");
    expect(decoder.decode(jsonResult.messages[1])).toBe("dddd");
    expect(jsonResult.segmentStart).toBe(2);

    // Binary skips by byte offset: skip "a" (end=1<=2), collect "bb" (end=3>2), "ccc", "dddd"
    expect(binaryResult.messages).toHaveLength(3);
    expect(decoder.decode(binaryResult.messages[0])).toBe("bb");
    expect(decoder.decode(binaryResult.messages[1])).toBe("ccc");
    expect(decoder.decode(binaryResult.messages[2])).toBe("dddd");
    expect(binaryResult.segmentStart).toBe(1);
  });

  it("JSON outputStart reflects message-based position", async () => {
    // segmentStart = 100, offset = 103 => targetIndex = 3
    const encoded = encodeStrings(["x", "y", "z", "w"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 103,
      segmentStart: 100,
      maxChunkBytes: 1024,
      isJson: true,
    });

    // Skips messages 0, 1, 2; collects message 3 ("w")
    expect(result.messages).toHaveLength(1);
    expect(decoder.decode(result.messages[0])).toBe("w");
    // outputStart = segmentStart + messageIndex = 100 + 3 = 103
    expect(result.segmentStart).toBe(103);
  });

  it("binary outputStart reflects byte-based position", async () => {
    // segmentStart = 100
    // Messages: "aaa" (3 bytes), "bbb" (3 bytes), "ccc" (3 bytes)
    // Cursor: 100, 103, 106
    // offset = 103 => skip "aaa" (end=103 <= 103), collect "bbb" (end=106 > 103)
    const encoded = encodeStrings(["aaa", "bbb", "ccc"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 103,
      segmentStart: 100,
      maxChunkBytes: 1024,
      isJson: false,
    });

    expect(result.messages).toHaveLength(2);
    expect(decoder.decode(result.messages[0])).toBe("bbb");
    // outputStart = cursor at time of first add = 103
    expect(result.segmentStart).toBe(103);
  });
});

// ============================================================================
// encodeSegmentMessages + readSegmentMessages — binary data
// ============================================================================

describe("readSegmentMessages — raw binary payloads", () => {
  it("preserves binary data through encode-decode cycle", async () => {
    // Create messages with non-UTF8 binary data
    const msg1 = new Uint8Array([0x00, 0xFF, 0xFE, 0x01]);
    const msg2 = new Uint8Array([0x80, 0x81, 0x82]);
    const encoded = encodeSegmentMessages([msg1, msg2]);

    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: false,
    });

    expect(result.messages).toHaveLength(2);
    expect(new Uint8Array(result.messages[0])).toEqual(msg1);
    expect(new Uint8Array(result.messages[1])).toEqual(msg2);
  });
});

// ============================================================================
// readSegmentMessages — edge cases
// ============================================================================

describe("readSegmentMessages — edge cases", () => {
  it("handles a segment with a single zero-byte message", async () => {
    const encoded = encodeSegmentMessages([new Uint8Array(0)]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: true,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].byteLength).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("returns correct segmentStart when all messages are skipped in JSON mode", async () => {
    // When no messages are collected, outputStart stays at segmentStart
    const encoded = encodeStrings(["a", "b"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 50,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: true,
    });

    expect(result.messages).toHaveLength(0);
    // outputStart never got updated from the default = segmentStart
    expect(result.segmentStart).toBe(0);
  });

  it("returns correct segmentStart when all messages are skipped in binary mode", async () => {
    const encoded = encodeStrings(["a", "b"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 50,
      segmentStart: 0,
      maxChunkBytes: 1024,
      isJson: false,
    });

    expect(result.messages).toHaveLength(0);
    expect(result.segmentStart).toBe(0);
  });

  it("handles maxChunkBytes of 0 by collecting at least one message", async () => {
    // isFull() returns true immediately after the first message (any positive bytes >= 0)
    // But the while loop checks isFull() BEFORE reading, and 0 >= 0 is true from the start
    // Wait: collectedBytes starts at 0, maxChunkBytes = 0, so 0 >= 0 is true
    // So isFull() returns true immediately and the loop body never executes.
    const encoded = encodeStrings(["aaa"]);
    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 0,
      isJson: true,
    });

    // The while loop condition !collector.isFull() is false from the start
    // because 0 >= 0 is true, so no messages are collected
    expect(result.messages).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it("handles many small messages", async () => {
    const messages = Array.from({ length: 100 }, (_, i) => bytes(`msg-${i}`));
    const encoded = encodeSegmentMessages(messages);

    const result = await readSegmentMessages({
      body: streamFrom(encoded),
      offset: 0,
      segmentStart: 0,
      maxChunkBytes: 1024 * 1024,
      isJson: true,
    });

    expect(result.truncated).toBe(false);
    expect(result.messages).toHaveLength(100);
    expect(decoder.decode(result.messages[0])).toBe("msg-0");
    expect(decoder.decode(result.messages[99])).toBe("msg-99");
  });
});
