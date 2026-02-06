import { describe, it, expect } from "vitest";
import { parsePutInput } from "../../../src/stream/create/parse";
import type { RawPutInput } from "../../../src/stream/types";
import { errorResponse } from "../../../src/protocol/errors";

// Helper to create a base RawPutInput
function baseRawInput(overrides: Partial<RawPutInput> = {}): RawPutInput {
  return {
    streamId: "test-stream",
    contentTypeHeader: "application/json",
    closedHeader: null,
    ttlHeader: null,
    expiresHeader: null,
    streamSeqHeader: null,
    bodyBytes: new Uint8Array(),
    producer: null,
    requestUrl: "http://localhost/v1/stream/test",
    ...overrides,
  };
}

describe("parsePutInput", () => {
  const now = Date.now();

  it("parses valid input successfully", () => {
    const raw = baseRawInput();
    const result = parsePutInput(raw, now);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.streamId).toBe("test-stream");
      expect(result.value.contentType).toBe("application/json");
      expect(result.value.requestedClosed).toBe(false);
      expect(result.value.now).toBe(now);
    }
  });

  it("returns error for mutually exclusive TTL and Expires-At headers", () => {
    const raw = baseRawInput({
      ttlHeader: "3600",
      expiresHeader: "2025-01-01T00:00:00Z",
    });
    const result = parsePutInput(raw, now);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.response.status).toBe(400);
    }
  });

  it("returns error for invalid TTL header", () => {
    const raw = baseRawInput({ ttlHeader: "not-a-number" });
    const result = parsePutInput(raw, now);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.response.status).toBe(400);
    }
  });

  it("returns error for invalid Expires-At header", () => {
    const raw = baseRawInput({ expiresHeader: "invalid-date" });
    const result = parsePutInput(raw, now);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.response.status).toBe(400);
    }
  });

  it("returns error for producer header parse error", () => {
    const raw = baseRawInput({
      producer: { error: errorResponse(400, "Producer headers must be provided together") },
    });
    const result = parsePutInput(raw, now);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.response.status).toBe(400);
    }
  });

  it("parses closed header", () => {
    const raw = baseRawInput({ closedHeader: "true" });
    const result = parsePutInput(raw, now);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.requestedClosed).toBe(true);
    }
  });

  it("calculates effective expires at from TTL", () => {
    const raw = baseRawInput({ ttlHeader: "3600" });
    const result = parsePutInput(raw, now);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.ttlSeconds).toBe(3600);
      expect(result.value.effectiveExpiresAt).toBe(now + 3600 * 1000);
    }
  });

  it("uses expires at from header", () => {
    const expiresAt = Date.now() + 3600000;
    const expiresAtIso = new Date(expiresAt).toISOString();
    const raw = baseRawInput({ expiresHeader: expiresAtIso });
    const result = parsePutInput(raw, now);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.ttlSeconds).toBeNull();
      expect(result.value.effectiveExpiresAt).toBe(expiresAt);
    }
  });

  it("normalizes empty JSON array to empty body", () => {
    const raw = baseRawInput({
      contentTypeHeader: "application/json",
      bodyBytes: new TextEncoder().encode("[]"),
    });
    const result = parsePutInput(raw, now);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.bodyBytes.length).toBe(0);
    }
  });

  it("preserves non-empty JSON array body", () => {
    const raw = baseRawInput({
      contentTypeHeader: "application/json",
      bodyBytes: new TextEncoder().encode("[1, 2, 3]"),
    });
    const result = parsePutInput(raw, now);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.bodyBytes.length).toBeGreaterThan(0);
    }
  });

  it("extracts producer from raw input", () => {
    const raw = baseRawInput({
      producer: { value: { id: "producer-1", epoch: 0, seq: 0 } },
    });
    const result = parsePutInput(raw, now);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.producer).toEqual({ id: "producer-1", epoch: 0, seq: 0 });
    }
  });
});
