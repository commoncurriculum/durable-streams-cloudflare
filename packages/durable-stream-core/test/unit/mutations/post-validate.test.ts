import { describe, it, expect } from "vitest";
import {
  validateStreamExists,
  isCloseOnlyOperation,
  hasContentType,
  validateContentTypeMatch,
  validateStreamNotClosed,
  validateNonEmptyBody,
} from "../../../src/mutations/post/validate";
import type { ParsedPostInput } from "../../../src/mutations/types";
import type { StreamMeta } from "../../../src/storage/storage";

// Helper to create a base ParsedPostInput
function baseParsedInput(overrides: Partial<ParsedPostInput> = {}): ParsedPostInput {
  return {
    streamId: "test-stream",
    closeStream: false,
    contentType: "application/json",
    streamSeq: null,
    bodyBytes: new Uint8Array([1, 2, 3]),
    producer: null,
    ...overrides,
  };
}

// Helper to create a base StreamMeta
function baseStreamMeta(overrides: Partial<StreamMeta> = {}): StreamMeta {
  return {
    stream_id: "test-stream",
    content_type: "application/json",
    closed: 0,
    tail_offset: 0,
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
    ...overrides,
  };
}

describe("validateStreamExists", () => {
  it("returns error for null meta", () => {
    const result = validateStreamExists(null);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.response.status).toBe(404);
    }
  });

  it("returns ok for existing stream", () => {
    const meta = baseStreamMeta();
    const result = validateStreamExists(meta);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value).toBe(meta);
    }
  });
});

describe("isCloseOnlyOperation", () => {
  it("returns true for empty body with close flag", () => {
    const input = baseParsedInput({
      bodyBytes: new Uint8Array(),
      closeStream: true,
    });

    expect(isCloseOnlyOperation(input)).toBe(true);
  });

  it("returns false for non-empty body with close flag", () => {
    const input = baseParsedInput({
      bodyBytes: new Uint8Array([1, 2, 3]),
      closeStream: true,
    });

    expect(isCloseOnlyOperation(input)).toBe(false);
  });

  it("returns false for empty body without close flag", () => {
    const input = baseParsedInput({
      bodyBytes: new Uint8Array(),
      closeStream: false,
    });

    expect(isCloseOnlyOperation(input)).toBe(false);
  });
});

describe("hasContentType", () => {
  it("returns true when contentType is present", () => {
    const input = baseParsedInput({ contentType: "application/json" });
    expect(hasContentType(input)).toBe(true);
  });

  it("returns false when contentType is null", () => {
    const input = baseParsedInput({ contentType: null });
    expect(hasContentType(input)).toBe(false);
  });

  it("narrows type to non-null contentType", () => {
    const input = baseParsedInput({ contentType: "application/json" });
    if (hasContentType(input)) {
      // TypeScript should allow this without error - contentType is narrowed to string
      const ct: string = input.contentType;
      expect(ct).toBe("application/json");
    }
  });
});

describe("validateContentTypeMatch", () => {
  it("returns null for matching content types", () => {
    const result = validateContentTypeMatch("application/json", "application/json");
    expect(result).toBeNull();
  });

  it("returns 409 for mismatched content types", () => {
    const result = validateContentTypeMatch("text/plain", "application/json");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(409);
  });

  it("normalizes content types for comparison", () => {
    // Both should normalize to "application/json"
    const result = validateContentTypeMatch("application/json", "application/json; charset=utf-8");
    // The stream's content type is already normalized when stored
    expect(result).toBeNull();
  });
});

describe("validateStreamNotClosed", () => {
  it("returns null for open stream", () => {
    const meta = baseStreamMeta({ closed: 0 });
    const result = validateStreamNotClosed(meta, "offset-header");

    expect(result).toBeNull();
  });

  it("returns 409 for closed stream", () => {
    const meta = baseStreamMeta({ closed: 1 });
    const result = validateStreamNotClosed(meta, "offset-header");

    expect(result).not.toBeNull();
    expect(result!.status).toBe(409);
  });
});

describe("validateNonEmptyBody", () => {
  it("returns null for non-empty body", () => {
    const result = validateNonEmptyBody(10, false);
    expect(result).toBeNull();
  });

  it("returns null for empty body with close flag", () => {
    const result = validateNonEmptyBody(0, true);
    expect(result).toBeNull();
  });

  it("returns 400 for empty body without close flag", () => {
    const result = validateNonEmptyBody(0, false);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(400);
  });
});
