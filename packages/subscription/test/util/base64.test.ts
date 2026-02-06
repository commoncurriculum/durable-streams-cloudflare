import { describe, it, expect } from "vitest";
import { bufferToBase64, base64ToBuffer } from "../../src/util/base64";

describe("base64", () => {
  it("round-trips text content", () => {
    const original = new TextEncoder().encode("hello world").buffer as ArrayBuffer;
    const encoded = bufferToBase64(original);
    const decoded = base64ToBuffer(encoded);

    expect(new TextDecoder().decode(decoded)).toBe("hello world");
  });

  it("round-trips binary content", () => {
    const original = new Uint8Array([0, 1, 127, 128, 255]).buffer as ArrayBuffer;
    const encoded = bufferToBase64(original);
    const decoded = base64ToBuffer(encoded);

    expect(new Uint8Array(decoded)).toEqual(new Uint8Array([0, 1, 127, 128, 255]));
  });

  it("round-trips empty buffer", () => {
    const original = new ArrayBuffer(0);
    const encoded = bufferToBase64(original);
    const decoded = base64ToBuffer(encoded);

    expect(decoded.byteLength).toBe(0);
  });
});
