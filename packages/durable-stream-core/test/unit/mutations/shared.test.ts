import { describe, it, expect } from "vitest";
import {
  validateContentLength,
  validateBodySize,
} from "../../../src/mutations/shared";

describe("validateContentLength", () => {
  it("returns null when no Content-Length header", () => {
    const result = validateContentLength(null, 100);
    expect(result).toBeNull();
  });

  it("returns null when Content-Length matches body length", () => {
    const result = validateContentLength("100", 100);
    expect(result).toBeNull();
  });

  it("returns 400 for invalid Content-Length", () => {
    const result = validateContentLength("not-a-number", 100);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(400);
  });

  it("returns 400 for Content-Length mismatch", () => {
    const result = validateContentLength("50", 100);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(400);
  });
});

describe("validateBodySize", () => {
  it("returns null for body within limits", () => {
    const result = validateBodySize(1000);
    expect(result).toBeNull();
  });

  it("returns 413 for body exceeding MAX_APPEND_BYTES", () => {
    const result = validateBodySize(10 * 1024 * 1024); // 10 MB
    expect(result).not.toBeNull();
    expect(result!.status).toBe(413);
  });
});
