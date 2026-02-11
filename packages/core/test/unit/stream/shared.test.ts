import { describe, it, expect } from "vitest";
import {
  validateContentLength,
  validateBodySize,
} from "../../../src/http/v1/streams/shared/body";

describe("validateContentLength", () => {
  it("returns ok when no Content-Length header", () => {
    const result = validateContentLength(null, 100);
    expect(result.kind).toBe("ok");
  });

  it("returns ok when Content-Length matches body length", () => {
    const result = validateContentLength("100", 100);
    expect(result.kind).toBe("ok");
  });

  it("returns error for invalid Content-Length", () => {
    const result = validateContentLength("not-a-number", 100);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.response.status).toBe(400);
    }
  });

  it("returns error for Content-Length mismatch", () => {
    const result = validateContentLength("50", 100);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.response.status).toBe(400);
    }
  });
});

describe("validateBodySize", () => {
  it("returns ok for body within limits", () => {
    const result = validateBodySize(1000);
    expect(result.kind).toBe("ok");
  });

  it("returns error for body exceeding MAX_APPEND_BYTES", () => {
    const result = validateBodySize(10 * 1024 * 1024); // 10 MB
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.response.status).toBe(413);
    }
  });
});
