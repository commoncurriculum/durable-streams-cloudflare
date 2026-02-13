import { describe, it, expect } from "vitest";
import { bufferToBase64, base64ToBuffer } from "../../../src/util/base64";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create an ArrayBuffer from a string using UTF-8 encoding
 */
function stringToBuffer(s: string): ArrayBuffer {
  const encoder = new TextEncoder();
  return encoder.encode(s).buffer;
}

/**
 * Convert an ArrayBuffer to string using UTF-8 decoding
 */
function bufferToString(buffer: ArrayBuffer): string {
  const decoder = new TextDecoder();
  return decoder.decode(buffer);
}

/**
 * Create an ArrayBuffer from raw byte values
 */
function bytesToBuffer(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

/**
 * Convert an ArrayBuffer to an array of byte values
 */
function bufferToBytes(buffer: ArrayBuffer): number[] {
  return Array.from(new Uint8Array(buffer));
}

// ============================================================================
// bufferToBase64 — basic functionality
// ============================================================================

describe("bufferToBase64", () => {
  it("encodes an empty buffer to an empty string", () => {
    const buffer = new ArrayBuffer(0);
    const result = bufferToBase64(buffer);
    expect(result).toBe("");
  });

  it("encodes a simple ASCII string buffer", () => {
    const buffer = stringToBuffer("hello");
    const result = bufferToBase64(buffer);
    // "hello" in base64 should be "aGVsbG8="
    expect(result).toBe("aGVsbG8=");
  });

  it("encodes a buffer with UTF-8 characters", () => {
    const buffer = stringToBuffer("Hello, 世界!");
    const result = bufferToBase64(buffer);
    // Result should be valid base64
    expect(result).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    expect(result.length).toBeGreaterThan(0);
  });

  it("encodes binary data correctly", () => {
    // Create a buffer with various byte values including 0x00 and 0xFF
    const buffer = bytesToBuffer([0x00, 0x01, 0x7f, 0x80, 0xff]);
    const result = bufferToBase64(buffer);
    expect(result).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    expect(result.length).toBeGreaterThan(0);
  });

  it("produces standard base64 encoding", () => {
    // Test known encodings
    const testCases = [
      { input: "a", expected: "YQ==" },
      { input: "ab", expected: "YWI=" },
      { input: "abc", expected: "YWJj" },
      { input: "Man", expected: "TWFu" },
    ];

    for (const { input, expected } of testCases) {
      const buffer = stringToBuffer(input);
      const result = bufferToBase64(buffer);
      expect(result).toBe(expected);
    }
  });
});

// ============================================================================
// bufferToBase64 — large buffers (chunk handling)
// ============================================================================

describe("bufferToBase64 — large buffers", () => {
  it("handles buffers smaller than chunk size (32KB)", () => {
    const size = 1024; // 1KB
    const buffer = new ArrayBuffer(size);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < size; i++) {
      view[i] = i % 256;
    }
    const result = bufferToBase64(buffer);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
  });

  it("handles buffers larger than chunk size (32KB)", () => {
    const size = 100_000; // 100KB, larger than 32KB chunk size
    const buffer = new ArrayBuffer(size);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < size; i++) {
      view[i] = i % 256;
    }
    const result = bufferToBase64(buffer);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
  });

  it("handles buffers exactly at chunk boundary (32KB)", () => {
    const size = 0x8000; // Exactly 32KB
    const buffer = new ArrayBuffer(size);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < size; i++) {
      view[i] = i % 256;
    }
    const result = bufferToBase64(buffer);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
  });

  it("handles very large buffers (multiple chunks)", () => {
    const size = 200_000; // 200KB, requires multiple 32KB chunks
    const buffer = new ArrayBuffer(size);
    const view = new Uint8Array(buffer);
    // Fill with predictable pattern
    for (let i = 0; i < size; i++) {
      view[i] = (i * 7) % 256;
    }
    const result = bufferToBase64(buffer);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
  });
});

// ============================================================================
// base64ToBuffer — basic functionality
// ============================================================================

describe("base64ToBuffer", () => {
  it("decodes an empty string to an empty buffer", () => {
    const result = base64ToBuffer("");
    expect(result.byteLength).toBe(0);
  });

  it("decodes a simple base64 string", () => {
    const base64 = "aGVsbG8="; // "hello" in base64
    const result = base64ToBuffer(base64);
    const text = bufferToString(result);
    expect(text).toBe("hello");
  });

  it("decodes base64 with UTF-8 content", () => {
    const buffer = stringToBuffer("Hello, 世界!");
    const base64 = bufferToBase64(buffer);
    const decoded = base64ToBuffer(base64);
    const text = bufferToString(decoded);
    expect(text).toBe("Hello, 世界!");
  });

  it("decodes binary data correctly", () => {
    const originalBytes = [0x00, 0x01, 0x7f, 0x80, 0xff];
    const buffer = bytesToBuffer(originalBytes);
    const base64 = bufferToBase64(buffer);
    const decoded = base64ToBuffer(base64);
    const decodedBytes = bufferToBytes(decoded);
    expect(decodedBytes).toEqual(originalBytes);
  });

  it("handles standard base64 padding", () => {
    const testCases = [
      { base64: "YQ==", expected: "a" }, // 2 padding chars
      { base64: "YWI=", expected: "ab" }, // 1 padding char
      { base64: "YWJj", expected: "abc" }, // no padding
    ];

    for (const { base64, expected } of testCases) {
      const result = base64ToBuffer(base64);
      const text = bufferToString(result);
      expect(text).toBe(expected);
    }
  });

  it("decodes base64 without padding", () => {
    // Some base64 implementations omit padding
    const base64 = "YWJj"; // "abc" without padding
    const result = base64ToBuffer(base64);
    const text = bufferToString(result);
    expect(text).toBe("abc");
  });
});

// ============================================================================
// base64ToBuffer — large strings
// ============================================================================

describe("base64ToBuffer — large strings", () => {
  it("handles small base64 strings", () => {
    const buffer = new ArrayBuffer(100);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < 100; i++) {
      view[i] = i;
    }
    const base64 = bufferToBase64(buffer);
    const decoded = base64ToBuffer(base64);
    expect(decoded.byteLength).toBe(100);
    expect(bufferToBytes(decoded)).toEqual(Array.from(view));
  });

  it("handles large base64 strings", () => {
    const size = 50_000;
    const buffer = new ArrayBuffer(size);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < size; i++) {
      view[i] = i % 256;
    }
    const base64 = bufferToBase64(buffer);
    const decoded = base64ToBuffer(base64);
    expect(decoded.byteLength).toBe(size);
    expect(bufferToBytes(decoded)).toEqual(Array.from(view));
  });

  it("handles very large base64 strings", () => {
    const size = 200_000;
    const buffer = new ArrayBuffer(size);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < size; i++) {
      view[i] = (i * 13) % 256;
    }
    const base64 = bufferToBase64(buffer);
    const decoded = base64ToBuffer(base64);
    expect(decoded.byteLength).toBe(size);
    // Verify first and last few bytes to avoid expensive full comparison
    const decodedView = new Uint8Array(decoded);
    expect(decodedView[0]).toBe(view[0]);
    expect(decodedView[size - 1]).toBe(view[size - 1]);
    expect(decodedView[100]).toBe(view[100]);
  });
});

// ============================================================================
// Round-trip testing
// ============================================================================

describe("bufferToBase64 <-> base64ToBuffer round-trip", () => {
  it("round-trips a simple string", () => {
    const original = "Hello, World!";
    const buffer = stringToBuffer(original);
    const base64 = bufferToBase64(buffer);
    const decoded = base64ToBuffer(base64);
    const result = bufferToString(decoded);
    expect(result).toBe(original);
  });

  it("round-trips UTF-8 strings", () => {
    const testCases = ["Hello, 世界!", "Emoji: 🎉🚀✨", "Кириллица", "العربية", "हिन्दी"];

    for (const original of testCases) {
      const buffer = stringToBuffer(original);
      const base64 = bufferToBase64(buffer);
      const decoded = base64ToBuffer(base64);
      const result = bufferToString(decoded);
      expect(result).toBe(original);
    }
  });

  it("round-trips binary data", () => {
    const testCases = [
      [0x00],
      [0xff],
      [0x00, 0xff],
      [0x01, 0x02, 0x03, 0x04],
      Array.from({ length: 256 }, (_, i) => i),
      [0xde, 0xad, 0xbe, 0xef],
    ];

    for (const originalBytes of testCases) {
      const buffer = bytesToBuffer(originalBytes);
      const base64 = bufferToBase64(buffer);
      const decoded = base64ToBuffer(base64);
      const decodedBytes = bufferToBytes(decoded);
      expect(decodedBytes).toEqual(originalBytes);
    }
  });

  it("round-trips empty buffer", () => {
    const buffer = new ArrayBuffer(0);
    const base64 = bufferToBase64(buffer);
    const decoded = base64ToBuffer(base64);
    expect(decoded.byteLength).toBe(0);
  });

  it("round-trips single byte", () => {
    for (let byte = 0; byte < 256; byte++) {
      const buffer = bytesToBuffer([byte]);
      const base64 = bufferToBase64(buffer);
      const decoded = base64ToBuffer(base64);
      const decodedBytes = bufferToBytes(decoded);
      expect(decodedBytes).toEqual([byte]);
    }
  });

  it("round-trips buffers at chunk boundaries", () => {
    const sizes = [
      0x7fff, // Just under 32KB
      0x8000, // Exactly 32KB
      0x8001, // Just over 32KB
      0x10000, // Exactly 64KB (2 chunks)
      0x18000, // 96KB (3 chunks)
    ];

    for (const size of sizes) {
      const buffer = new ArrayBuffer(size);
      const view = new Uint8Array(buffer);
      for (let i = 0; i < size; i++) {
        view[i] = i % 256;
      }
      const base64 = bufferToBase64(buffer);
      const decoded = base64ToBuffer(base64);
      expect(decoded.byteLength).toBe(size);
      // Verify first and last bytes
      const decodedView = new Uint8Array(decoded);
      expect(decodedView[0]).toBe(0);
      if (size > 0) {
        expect(decodedView[size - 1]).toBe((size - 1) % 256);
      }
    }
  });

  it("round-trips random binary data", () => {
    const size = 10_000;
    const buffer = new ArrayBuffer(size);
    const view = new Uint8Array(buffer);

    // Fill with pseudo-random data
    let seed = 12345;
    for (let i = 0; i < size; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      view[i] = seed % 256;
    }

    const base64 = bufferToBase64(buffer);
    const decoded = base64ToBuffer(base64);
    const decodedBytes = bufferToBytes(decoded);
    const originalBytes = Array.from(view);

    expect(decodedBytes).toEqual(originalBytes);
  });
});

// ============================================================================
// Edge cases and special characters
// ============================================================================

describe("bufferToBase64 — edge cases", () => {
  it("handles all possible byte values", () => {
    const buffer = bytesToBuffer(Array.from({ length: 256 }, (_, i) => i));
    const base64 = bufferToBase64(buffer);
    const decoded = base64ToBuffer(base64);
    const decodedBytes = bufferToBytes(decoded);

    expect(decodedBytes).toEqual(Array.from({ length: 256 }, (_, i) => i));
  });

  it("handles repeated null bytes", () => {
    const buffer = bytesToBuffer([0, 0, 0, 0, 0]);
    const base64 = bufferToBase64(buffer);
    expect(base64).toBe("AAAAAAA=");
    const decoded = base64ToBuffer(base64);
    expect(bufferToBytes(decoded)).toEqual([0, 0, 0, 0, 0]);
  });

  it("handles repeated 0xFF bytes", () => {
    const buffer = bytesToBuffer([0xff, 0xff, 0xff, 0xff]);
    const base64 = bufferToBase64(buffer);
    const decoded = base64ToBuffer(base64);
    expect(bufferToBytes(decoded)).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  it("handles alternating byte patterns", () => {
    const buffer = bytesToBuffer([0xaa, 0x55, 0xaa, 0x55]);
    const base64 = bufferToBase64(buffer);
    const decoded = base64ToBuffer(base64);
    expect(bufferToBytes(decoded)).toEqual([0xaa, 0x55, 0xaa, 0x55]);
  });
});

// ============================================================================
// base64ToBuffer — error handling
// ============================================================================

describe("base64ToBuffer — invalid input", () => {
  it("throws on invalid base64 characters", () => {
    // atob will throw on invalid characters
    expect(() => base64ToBuffer("invalid@#$")).toThrow();
  });

  it("throws on malformed base64", () => {
    // atob may throw on certain malformed inputs
    expect(() => base64ToBuffer("a")).toThrow();
  });

  it("handles base64 with whitespace (if supported by runtime)", () => {
    // Different runtimes handle whitespace differently
    // Some will throw, some will ignore it
    // This test documents the behavior rather than enforcing it
    try {
      const result = base64ToBuffer("YWJj\n");
      // If it doesn't throw, verify the result
      expect(result.byteLength).toBeGreaterThanOrEqual(0);
    } catch (error) {
      // If it throws, that's also valid behavior
      expect(error).toBeDefined();
    }
  });
});

// ============================================================================
// Performance characteristics
// ============================================================================

describe("bufferToBase64 — performance characteristics", () => {
  it("completes in reasonable time for medium buffers", () => {
    const size = 10_000;
    const buffer = new ArrayBuffer(size);
    const start = Date.now();
    bufferToBase64(buffer);
    const duration = Date.now() - start;

    // Should complete in well under 100ms for 10KB
    expect(duration).toBeLessThan(100);
  });

  it("completes in reasonable time for large buffers", () => {
    const size = 100_000;
    const buffer = new ArrayBuffer(size);
    const start = Date.now();
    bufferToBase64(buffer);
    const duration = Date.now() - start;

    // Should complete in well under 1000ms for 100KB
    expect(duration).toBeLessThan(1000);
  });
});

describe("base64ToBuffer — performance characteristics", () => {
  it("completes in reasonable time for medium strings", () => {
    const buffer = new ArrayBuffer(10_000);
    const base64 = bufferToBase64(buffer);
    const start = Date.now();
    base64ToBuffer(base64);
    const duration = Date.now() - start;

    // Should complete in well under 100ms
    expect(duration).toBeLessThan(100);
  });

  it("completes in reasonable time for large strings", () => {
    const buffer = new ArrayBuffer(100_000);
    const base64 = bufferToBase64(buffer);
    const start = Date.now();
    base64ToBuffer(base64);
    const duration = Date.now() - start;

    // Should complete in well under 1000ms
    expect(duration).toBeLessThan(1000);
  });
});
