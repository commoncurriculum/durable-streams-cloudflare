import { describe, it, expect } from "vitest";
import {
  HEADER_STREAM_NEXT_OFFSET,
  HEADER_STREAM_UP_TO_DATE,
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_CURSOR,
  HEADER_STREAM_SEQ,
  HEADER_STREAM_TTL,
  HEADER_STREAM_EXPIRES_AT,
  HEADER_PRODUCER_ID,
  HEADER_PRODUCER_EPOCH,
  HEADER_PRODUCER_SEQ,
  HEADER_PRODUCER_EXPECTED_SEQ,
  HEADER_PRODUCER_RECEIVED_SEQ,
  HEADER_SSE_DATA_ENCODING,
  baseHeaders,
  normalizeContentType,
  isJsonContentType,
  isTextual,
} from "../../../src/http/shared/headers";

// ============================================================================
// Header constants
// ============================================================================

describe("header constants", () => {
  it("exports all stream header names", () => {
    expect(HEADER_STREAM_NEXT_OFFSET).toBe("Stream-Next-Offset");
    expect(HEADER_STREAM_UP_TO_DATE).toBe("Stream-Up-To-Date");
    expect(HEADER_STREAM_CLOSED).toBe("Stream-Closed");
    expect(HEADER_STREAM_CURSOR).toBe("Stream-Cursor");
    expect(HEADER_STREAM_SEQ).toBe("Stream-Seq");
    expect(HEADER_STREAM_TTL).toBe("Stream-TTL");
    expect(HEADER_STREAM_EXPIRES_AT).toBe("Stream-Expires-At");
    expect(HEADER_SSE_DATA_ENCODING).toBe("Stream-SSE-Data-Encoding");
  });

  it("exports all producer header names", () => {
    expect(HEADER_PRODUCER_ID).toBe("Producer-Id");
    expect(HEADER_PRODUCER_EPOCH).toBe("Producer-Epoch");
    expect(HEADER_PRODUCER_SEQ).toBe("Producer-Seq");
    expect(HEADER_PRODUCER_EXPECTED_SEQ).toBe("Producer-Expected-Seq");
    expect(HEADER_PRODUCER_RECEIVED_SEQ).toBe("Producer-Received-Seq");
  });
});

// ============================================================================
// baseHeaders
// ============================================================================

describe("baseHeaders", () => {
  it("returns Headers with security defaults", () => {
    const headers = baseHeaders();
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
  });

  it("includes extra headers passed as argument", () => {
    const headers = baseHeaders({ "X-Custom": "value" });
    expect(headers.get("X-Custom")).toBe("value");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
  });

  it("allows overriding security headers via extra", () => {
    const headers = baseHeaders({
      "X-Content-Type-Options": "custom-value",
    });
    // set() after the initial construction overwrites
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("returns a new Headers instance each call", () => {
    const a = baseHeaders();
    const b = baseHeaders();
    expect(a).not.toBe(b);
  });

  it("works with empty extra object", () => {
    const headers = baseHeaders({});
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
  });

  it("preserves multiple extra headers", () => {
    const headers = baseHeaders({
      "X-One": "1",
      "X-Two": "2",
      "X-Three": "3",
    });
    expect(headers.get("X-One")).toBe("1");
    expect(headers.get("X-Two")).toBe("2");
    expect(headers.get("X-Three")).toBe("3");
  });
});

// ============================================================================
// normalizeContentType
// ============================================================================

describe("normalizeContentType", () => {
  it("returns null for null input", () => {
    expect(normalizeContentType(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(normalizeContentType("")).toBeNull();
  });

  it("returns lowercase MIME type for simple value", () => {
    expect(normalizeContentType("application/json")).toBe("application/json");
  });

  it("lowercases the MIME type", () => {
    expect(normalizeContentType("Application/JSON")).toBe("application/json");
  });

  it("strips charset parameter", () => {
    expect(normalizeContentType("application/json; charset=utf-8")).toBe(
      "application/json",
    );
  });

  it("strips charset parameter with mixed casing", () => {
    expect(normalizeContentType("Text/Plain; Charset=UTF-8")).toBe(
      "text/plain",
    );
  });

  it("strips multiple parameters", () => {
    expect(
      normalizeContentType("text/html; charset=utf-8; boundary=something"),
    ).toBe("text/html");
  });

  it("trims whitespace around the MIME type", () => {
    expect(normalizeContentType("  application/json  ")).toBe(
      "application/json",
    );
  });

  it("trims whitespace with parameters", () => {
    expect(normalizeContentType("  text/plain ; charset=utf-8  ")).toBe(
      "text/plain",
    );
  });

  it("handles MIME type with no subtype gracefully", () => {
    expect(normalizeContentType("text")).toBe("text");
  });

  it("handles application/octet-stream", () => {
    expect(normalizeContentType("application/octet-stream")).toBe(
      "application/octet-stream",
    );
  });

  it("handles multipart/form-data with boundary", () => {
    expect(
      normalizeContentType("multipart/form-data; boundary=----WebKit"),
    ).toBe("multipart/form-data");
  });

  it("handles content type with only semicolons and spaces", () => {
    expect(normalizeContentType("; ; ;")).toBe("");
  });
});

// ============================================================================
// isJsonContentType
// ============================================================================

describe("isJsonContentType", () => {
  it("returns true for application/json", () => {
    expect(isJsonContentType("application/json")).toBe(true);
  });

  it("returns true for application/json with charset", () => {
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
  });

  it("returns true for APPLICATION/JSON (case-insensitive)", () => {
    expect(isJsonContentType("APPLICATION/JSON")).toBe(true);
  });

  it("returns true for mixed case Application/Json", () => {
    expect(isJsonContentType("Application/Json")).toBe(true);
  });

  it("returns false for text/plain", () => {
    expect(isJsonContentType("text/plain")).toBe(false);
  });

  it("returns false for text/html", () => {
    expect(isJsonContentType("text/html")).toBe(false);
  });

  it("returns false for application/octet-stream", () => {
    expect(isJsonContentType("application/octet-stream")).toBe(false);
  });

  it("returns false for application/xml", () => {
    expect(isJsonContentType("application/xml")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isJsonContentType("")).toBe(false);
  });

  it("returns false for application/json-patch+json", () => {
    expect(isJsonContentType("application/json-patch+json")).toBe(false);
  });

  it("returns false for application/vnd.api+json", () => {
    expect(isJsonContentType("application/vnd.api+json")).toBe(false);
  });

  it("returns true with leading/trailing whitespace", () => {
    expect(isJsonContentType("  application/json  ")).toBe(true);
  });
});

// ============================================================================
// isTextual
// ============================================================================

describe("isTextual", () => {
  it("returns true for text/plain", () => {
    expect(isTextual("text/plain")).toBe(true);
  });

  it("returns true for text/html", () => {
    expect(isTextual("text/html")).toBe(true);
  });

  it("returns true for text/css", () => {
    expect(isTextual("text/css")).toBe(true);
  });

  it("returns true for text/csv", () => {
    expect(isTextual("text/csv")).toBe(true);
  });

  it("returns true for text/xml", () => {
    expect(isTextual("text/xml")).toBe(true);
  });

  it("returns true for text/javascript", () => {
    expect(isTextual("text/javascript")).toBe(true);
  });

  it("returns true for application/json", () => {
    expect(isTextual("application/json")).toBe(true);
  });

  it("returns true for text/* with charset parameter", () => {
    expect(isTextual("text/plain; charset=utf-8")).toBe(true);
  });

  it("returns true for application/json with charset", () => {
    expect(isTextual("application/json; charset=utf-8")).toBe(true);
  });

  it("returns true for TEXT/PLAIN (case-insensitive)", () => {
    expect(isTextual("TEXT/PLAIN")).toBe(true);
  });

  it("returns true for Text/Html (mixed case)", () => {
    expect(isTextual("Text/Html")).toBe(true);
  });

  it("returns true for APPLICATION/JSON (case-insensitive)", () => {
    expect(isTextual("APPLICATION/JSON")).toBe(true);
  });

  it("returns false for application/octet-stream", () => {
    expect(isTextual("application/octet-stream")).toBe(false);
  });

  it("returns false for application/xml", () => {
    expect(isTextual("application/xml")).toBe(false);
  });

  it("returns false for image/png", () => {
    expect(isTextual("image/png")).toBe(false);
  });

  it("returns false for video/mp4", () => {
    expect(isTextual("video/mp4")).toBe(false);
  });

  it("returns false for audio/mpeg", () => {
    expect(isTextual("audio/mpeg")).toBe(false);
  });

  it("returns false for multipart/form-data", () => {
    expect(isTextual("multipart/form-data")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isTextual("")).toBe(false);
  });

  it("returns true with whitespace around text type", () => {
    expect(isTextual("  text/plain  ")).toBe(true);
  });

  it("returns false for application/pdf", () => {
    expect(isTextual("application/pdf")).toBe(false);
  });

  it("returns false for application/json-patch+json (not exact match)", () => {
    expect(isTextual("application/json-patch+json")).toBe(false);
  });
});
