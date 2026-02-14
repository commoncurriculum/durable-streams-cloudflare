import { describe, it, expect } from "vitest";
import {
  concatBuffers,
  toUint8Array,
  base64Encode,
} from "../../../../../../src/http/v1/streams/shared/encoding";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a Uint8Array from a string using UTF-8 encoding
 */
function stringToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Decode a Uint8Array to string using UTF-8 decoding
 */
function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// ============================================================================
// concatBuffers
// ============================================================================

describe("concatBuffers", () => {
  it("concatenates empty array to empty buffer", () => {
    const result = concatBuffers([]);
    expect(result.byteLength).toBe(0);
  });

  it("concatenates single chunk", () => {
    const chunk = stringToBytes("hello");
    const result = concatBuffers([chunk]);
    expect(result.byteLength).toBe(5);
    const text = bytesToString(new Uint8Array(result));
    expect(text).toBe("hello");
  });

  it("concatenates multiple chunks", () => {
    const chunks = [stringToBytes("hello"), stringToBytes(" "), stringToBytes("world")];
    const result = concatBuffers(chunks);
    expect(result.byteLength).toBe(11);
    const text = bytesToString(new Uint8Array(result));
    expect(text).toBe("hello world");
  });

  it("concatenates binary data chunks", () => {
    const chunk1 = new Uint8Array([0x01, 0x02, 0x03]);
    const chunk2 = new Uint8Array([0x04, 0x05]);
    const chunk3 = new Uint8Array([0x06]);
    const result = concatBuffers([chunk1, chunk2, chunk3]);
    const bytes = new Uint8Array(result);
    expect(Array.from(bytes)).toEqual([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
  });

  it("handles chunks with different sizes", () => {
    const chunks = [
      new Uint8Array(1),
      new Uint8Array(10),
      new Uint8Array(100),
      new Uint8Array(1000),
    ];
    chunks[0][0] = 0x01;
    chunks[1][0] = 0x02;
    chunks[2][0] = 0x03;
    chunks[3][0] = 0x04;

    const result = concatBuffers(chunks);
    expect(result.byteLength).toBe(1111);
    const bytes = new Uint8Array(result);
    expect(bytes[0]).toBe(0x01);
    expect(bytes[1]).toBe(0x02);
    expect(bytes[11]).toBe(0x03);
    expect(bytes[111]).toBe(0x04);
  });

  it("preserves all byte values (0x00-0xFF)", () => {
    const chunk1 = new Uint8Array([0x00, 0x01, 0x7f]);
    const chunk2 = new Uint8Array([0x80, 0xfe, 0xff]);
    const result = concatBuffers([chunk1, chunk2]);
    const bytes = new Uint8Array(result);
    expect(Array.from(bytes)).toEqual([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);
  });

  it("handles UTF-8 multibyte sequences across chunks", () => {
    const text = "Hello, 世界!";
    const fullBytes = stringToBytes(text);
    // Split into chunks at arbitrary positions
    const chunk1 = fullBytes.slice(0, 7);
    const chunk2 = fullBytes.slice(7, 10);
    const chunk3 = fullBytes.slice(10);
    const result = concatBuffers([chunk1, chunk2, chunk3]);
    const decoded = bytesToString(new Uint8Array(result));
    expect(decoded).toBe(text);
  });

  it("returns correct buffer with large number of small chunks", () => {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 100; i++) {
      chunks.push(new Uint8Array([i % 256]));
    }
    const result = concatBuffers(chunks);
    expect(result.byteLength).toBe(100);
    const bytes = new Uint8Array(result);
    for (let i = 0; i < 100; i++) {
      expect(bytes[i]).toBe(i % 256);
    }
  });
});

// ============================================================================
// toUint8Array
// ============================================================================

describe("toUint8Array", () => {
  it("returns Uint8Array as-is", () => {
    const input = new Uint8Array([1, 2, 3]);
    const result = toUint8Array(input);
    expect(result).toBe(input); // Same reference
    expect(Array.from(result)).toEqual([1, 2, 3]);
  });

  it("converts ArrayBuffer to Uint8Array", () => {
    const buffer = new ArrayBuffer(3);
    const view = new Uint8Array(buffer);
    view[0] = 1;
    view[1] = 2;
    view[2] = 3;

    const result = toUint8Array(buffer);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([1, 2, 3]);
  });

  it("converts number array to Uint8Array", () => {
    const input = [1, 2, 3, 4, 5];
    const result = toUint8Array(input);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
  });

  it("converts string to UTF-8 encoded Uint8Array", () => {
    const result = toUint8Array("hello");
    expect(result).toBeInstanceOf(Uint8Array);
    const decoded = bytesToString(result);
    expect(decoded).toBe("hello");
  });

  it("handles empty inputs", () => {
    expect(toUint8Array(new Uint8Array(0)).byteLength).toBe(0);
    expect(toUint8Array(new ArrayBuffer(0)).byteLength).toBe(0);
    expect(toUint8Array([]).byteLength).toBe(0);
    expect(toUint8Array("").byteLength).toBe(0);
  });

  it("converts ArrayBuffer with all byte values", () => {
    const buffer = new ArrayBuffer(256);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < 256; i++) {
      view[i] = i;
    }
    const result = toUint8Array(buffer);
    expect(Array.from(result)).toEqual(Array.from({ length: 256 }, (_, i) => i));
  });

  it("converts number array with all byte values", () => {
    const input = Array.from({ length: 256 }, (_, i) => i);
    const result = toUint8Array(input);
    expect(Array.from(result)).toEqual(input);
  });

  it("converts string with UTF-8 multibyte characters", () => {
    const input = "Hello, 世界! 🎉";
    const result = toUint8Array(input);
    const decoded = bytesToString(result);
    expect(decoded).toBe(input);
  });

  it("handles binary data in number array", () => {
    const input = [0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff];
    const result = toUint8Array(input);
    expect(Array.from(result)).toEqual(input);
  });

  it("converts ArrayBuffer from typed array buffer property", () => {
    const typed = new Uint8Array([10, 20, 30]);
    const result = toUint8Array(typed.buffer);
    expect(Array.from(result)).toEqual([10, 20, 30]);
  });
});

// ============================================================================
// base64Encode
// ============================================================================

describe("base64Encode", () => {
  it("encodes empty bytes to empty string", () => {
    const bytes = new Uint8Array(0);
    const result = base64Encode(bytes);
    expect(result).toBe("");
  });

  it("encodes simple ASCII bytes", () => {
    const bytes = stringToBytes("hello");
    const result = base64Encode(bytes);
    expect(result).toBe("aGVsbG8=");
  });

  it("encodes UTF-8 multibyte characters", () => {
    const bytes = stringToBytes("Hello, 世界!");
    const result = base64Encode(bytes);
    // Decode to verify correctness
    const decoded = new Uint8Array(
      atob(result)
        .split("")
        .map((c) => c.charCodeAt(0)),
    );
    expect(bytesToString(decoded)).toBe("Hello, 世界!");
  });

  it("encodes binary data", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xff]);
    const result = base64Encode(bytes);
    expect(result).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    // Verify round-trip
    const decoded = new Uint8Array(
      atob(result)
        .split("")
        .map((c) => c.charCodeAt(0)),
    );
    expect(Array.from(decoded)).toEqual([0x00, 0x01, 0x7f, 0x80, 0xff]);
  });

  it("produces standard base64 encoding", () => {
    const testCases = [
      { input: "a", expected: "YQ==" },
      { input: "ab", expected: "YWI=" },
      { input: "abc", expected: "YWJj" },
      { input: "Man", expected: "TWFu" },
    ];

    for (const { input, expected } of testCases) {
      const bytes = stringToBytes(input);
      const result = base64Encode(bytes);
      expect(result).toBe(expected);
    }
  });

  it("handles all possible byte values", () => {
    const bytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
    const result = base64Encode(bytes);
    expect(result).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    // Verify round-trip
    const decoded = new Uint8Array(
      atob(result)
        .split("")
        .map((c) => c.charCodeAt(0)),
    );
    expect(Array.from(decoded)).toEqual(Array.from({ length: 256 }, (_, i) => i));
  });

  it("encodes single byte", () => {
    for (let byte = 0; byte < 256; byte++) {
      const bytes = new Uint8Array([byte]);
      const result = base64Encode(bytes);
      expect(result).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    }
  });

  it("handles repeated null bytes", () => {
    const bytes = new Uint8Array([0, 0, 0, 0, 0]);
    const result = base64Encode(bytes);
    expect(result).toBe("AAAAAAA=");
  });

  it("handles repeated 0xFF bytes", () => {
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    const result = base64Encode(bytes);
    const decoded = new Uint8Array(
      atob(result)
        .split("")
        .map((c) => c.charCodeAt(0)),
    );
    expect(Array.from(decoded)).toEqual([0xff, 0xff, 0xff, 0xff]);
  });
});

// ============================================================================
// base64Encode — chunk handling (lines 22-25)
// ============================================================================

describe("base64Encode — chunk handling", () => {
  it("handles buffers smaller than chunk size (32KB)", () => {
    const size = 1024; // 1KB
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      bytes[i] = i % 256;
    }
    const result = base64Encode(bytes);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    // Verify correctness
    const decoded = new Uint8Array(
      atob(result)
        .split("")
        .map((c) => c.charCodeAt(0)),
    );
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it("handles buffers larger than chunk size (32KB)", () => {
    const size = 100_000; // 100KB, larger than 32KB chunk size
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      bytes[i] = i % 256;
    }
    const result = base64Encode(bytes);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    // Verify first and last bytes to avoid expensive full decode
    const decoded = new Uint8Array(
      atob(result)
        .split("")
        .map((c) => c.charCodeAt(0)),
    );
    expect(decoded[0]).toBe(0);
    expect(decoded[size - 1]).toBe((size - 1) % 256);
  });

  it("handles buffers exactly at chunk boundary (32KB)", () => {
    const size = 0x8000; // Exactly 32KB
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      bytes[i] = i % 256;
    }
    const result = base64Encode(bytes);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    // Verify correctness
    const decoded = new Uint8Array(
      atob(result)
        .split("")
        .map((c) => c.charCodeAt(0)),
    );
    expect(decoded.byteLength).toBe(size);
    expect(decoded[0]).toBe(0);
    expect(decoded[size - 1]).toBe((size - 1) % 256);
  });

  it("handles very large buffers (multiple chunks)", () => {
    const size = 200_000; // 200KB, requires multiple 32KB chunks
    const bytes = new Uint8Array(size);
    // Fill with predictable pattern
    for (let i = 0; i < size; i++) {
      bytes[i] = (i * 7) % 256;
    }
    const result = base64Encode(bytes);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    // Verify first, middle, and last bytes
    const decoded = new Uint8Array(
      atob(result)
        .split("")
        .map((c) => c.charCodeAt(0)),
    );
    expect(decoded.byteLength).toBe(size);
    expect(decoded[0]).toBe(0);
    expect(decoded[100_000]).toBe((100_000 * 7) % 256);
    expect(decoded[size - 1]).toBe(((size - 1) * 7) % 256);
  });

  it("handles buffers at chunk boundaries", () => {
    const sizes = [
      0x7fff, // Just under 32KB
      0x8000, // Exactly 32KB
      0x8001, // Just over 32KB
      0x10000, // Exactly 64KB (2 chunks)
      0x18000, // 96KB (3 chunks)
    ];

    for (const size of sizes) {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        bytes[i] = i % 256;
      }
      const result = base64Encode(bytes);
      expect(result).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
      // Verify first and last bytes
      const decoded = new Uint8Array(
        atob(result)
          .split("")
          .map((c) => c.charCodeAt(0)),
      );
      expect(decoded[0]).toBe(0);
      if (size > 0) {
        expect(decoded[size - 1]).toBe((size - 1) % 256);
      }
    }
  });

  it("processes chunks correctly with partial last chunk", () => {
    // Size that creates an incomplete last chunk
    const size = 0x8000 + 100; // 32KB + 100 bytes
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      bytes[i] = i % 256;
    }
    const result = base64Encode(bytes);
    const decoded = new Uint8Array(
      atob(result)
        .split("")
        .map((c) => c.charCodeAt(0)),
    );
    // Verify bytes at chunk boundary
    expect(decoded[0x8000 - 1]).toBe((0x8000 - 1) % 256); // Last byte of first chunk
    expect(decoded[0x8000]).toBe(0x8000 % 256); // First byte of second chunk
    expect(decoded[size - 1]).toBe((size - 1) % 256); // Last byte
  });

  it("handles random binary data across multiple chunks", () => {
    const size = 150_000; // ~150KB to span multiple chunks
    const bytes = new Uint8Array(size);

    // Fill with pseudo-random data
    let seed = 42;
    for (let i = 0; i < size; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      bytes[i] = seed % 256;
    }

    const result = base64Encode(bytes);
    const decoded = new Uint8Array(
      atob(result)
        .split("")
        .map((c) => c.charCodeAt(0)),
    );

    // Verify full content
    expect(decoded.byteLength).toBe(size);
    // Spot check at various positions
    expect(decoded[0]).toBe(bytes[0]);
    expect(decoded[50_000]).toBe(bytes[50_000]);
    expect(decoded[100_000]).toBe(bytes[100_000]);
    expect(decoded[size - 1]).toBe(bytes[size - 1]);
  });
});

// ============================================================================
// Integration tests — combining functions
// ============================================================================

describe("integration — combining encoding functions", () => {
  it("concatBuffers + base64Encode", () => {
    const chunks = [stringToBytes("hello"), stringToBytes(" "), stringToBytes("world")];
    const concatenated = concatBuffers(chunks);
    const result = base64Encode(new Uint8Array(concatenated));
    expect(result).toBe("aGVsbG8gd29ybGQ=");
  });

  it("toUint8Array + base64Encode with string input", () => {
    const result = base64Encode(toUint8Array("hello"));
    expect(result).toBe("aGVsbG8=");
  });

  it("toUint8Array + base64Encode with ArrayBuffer input", () => {
    const buffer = new ArrayBuffer(3);
    const view = new Uint8Array(buffer);
    view[0] = 0x01;
    view[1] = 0x02;
    view[2] = 0x03;
    const result = base64Encode(toUint8Array(buffer));
    expect(result).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
  });

  it("toUint8Array + base64Encode with number array input", () => {
    const result = base64Encode(toUint8Array([72, 101, 108, 108, 111]));
    expect(result).toBe("SGVsbG8=");
  });

  it("full pipeline with multiple chunks and encoding", () => {
    const inputs = ["hello", new Uint8Array([32]), new ArrayBuffer(5)];
    // Fill the ArrayBuffer
    const view = new Uint8Array(inputs[2] as ArrayBuffer);
    const worldBytes = stringToBytes("world");
    view.set(worldBytes);

    const chunks = inputs.map((input) => {
      if (typeof input === "string") {
        return toUint8Array(input);
      }
      if (input instanceof Uint8Array) {
        return input;
      }
      return toUint8Array(input);
    });

    const concatenated = concatBuffers(chunks);
    const encoded = base64Encode(new Uint8Array(concatenated));
    expect(encoded).toBe("aGVsbG8gd29ybGQ=");
  });
});
