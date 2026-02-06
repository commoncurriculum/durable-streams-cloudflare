import { describe, it, expect } from "vitest";
import { parsePostInput } from "../../../src/stream/append/parse";
import type { RawPostInput } from "../../../src/stream/types";
import { errorResponse } from "../../../src/protocol/errors";

// Helper to create a base RawPostInput
function baseRawInput(overrides: Partial<RawPostInput> = {}): RawPostInput {
  return {
    streamId: "test-stream",
    closedHeader: null,
    contentTypeHeader: "application/json",
    streamSeqHeader: null,
    bodyBytes: new Uint8Array([1, 2, 3]),
    producer: null,
    ...overrides,
  };
}

describe("parsePostInput", () => {
  it("parses valid input successfully", () => {
    const raw = baseRawInput();
    const result = parsePostInput(raw);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.streamId).toBe("test-stream");
      expect(result.value.contentType).toBe("application/json");
      expect(result.value.closeStream).toBe(false);
      expect(result.value.producer).toBeNull();
    }
  });

  it("returns error for producer header parse error", () => {
    const raw = baseRawInput({
      producer: { error: errorResponse(400, "Producer headers must be provided together") },
    });
    const result = parsePostInput(raw);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.response.status).toBe(400);
    }
  });

  it("parses closed header as true", () => {
    const raw = baseRawInput({ closedHeader: "true" });
    const result = parsePostInput(raw);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.closeStream).toBe(true);
    }
  });

  it("parses closed header as false for other values", () => {
    const raw = baseRawInput({ closedHeader: "false" });
    const result = parsePostInput(raw);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.closeStream).toBe(false);
    }
  });

  it("extracts producer from raw input", () => {
    const raw = baseRawInput({
      producer: { value: { id: "producer-1", epoch: 1, seq: 5 } },
    });
    const result = parsePostInput(raw);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.producer).toEqual({ id: "producer-1", epoch: 1, seq: 5 });
    }
  });

  it("extracts stream sequence header", () => {
    const raw = baseRawInput({ streamSeqHeader: "seq-123" });
    const result = parsePostInput(raw);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.streamSeq).toBe("seq-123");
    }
  });

  it("preserves body bytes", () => {
    const bodyBytes = new Uint8Array([10, 20, 30]);
    const raw = baseRawInput({ bodyBytes });
    const result = parsePostInput(raw);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.bodyBytes).toEqual(bodyBytes);
    }
  });

  it("handles empty body", () => {
    const raw = baseRawInput({ bodyBytes: new Uint8Array() });
    const result = parsePostInput(raw);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.bodyBytes.length).toBe(0);
    }
  });

  it("handles null content type", () => {
    const raw = baseRawInput({ contentTypeHeader: null });
    const result = parsePostInput(raw);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.contentType).toBeNull();
    }
  });
});
