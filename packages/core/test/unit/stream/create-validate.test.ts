import { describe, it, expect } from "vitest";
import { validatePutInput } from "../../../src/http/v1/streams/create/validate";
import type { ParsedPutInput } from "../../../src/http/v1/streams/types";
import type { StreamMeta } from "../../../src/storage/types";

// Helper to create a base ParsedPutInput
function baseParsedInput(overrides: Partial<ParsedPutInput> = {}): ParsedPutInput {
  return {
    streamId: "test-stream",
    contentType: "application/json",
    requestedClosed: false,
    ttlSeconds: null,
    effectiveExpiresAt: null,
    bodyBytes: new Uint8Array(),
    streamSeq: null,
    producer: null,
    requestUrl: "http://localhost/v1/stream/test",
    now: Date.now(),
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

describe("validatePutInput (idempotent PUT)", () => {
  it("returns 409 for content-type mismatch", () => {
    const input = baseParsedInput({ contentType: "text/plain" });
    const existing = baseStreamMeta({ content_type: "application/json" });

    const result = validatePutInput(input, existing);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.response.status).toBe(409);
    }
  });

  it("returns 409 for closed status mismatch (request closed, stream open)", () => {
    const input = baseParsedInput({ requestedClosed: true });
    const existing = baseStreamMeta({ closed: 0 });

    const result = validatePutInput(input, existing);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.response.status).toBe(409);
    }
  });

  it("returns 409 for closed status mismatch (request open, stream closed)", () => {
    const input = baseParsedInput({ requestedClosed: false });
    const existing = baseStreamMeta({ closed: 1 });

    const result = validatePutInput(input, existing);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.response.status).toBe(409);
    }
  });

  it("returns 409 for TTL mismatch", () => {
    const input = baseParsedInput({ ttlSeconds: 3600 });
    const existing = baseStreamMeta({ ttl_seconds: null });

    const result = validatePutInput(input, existing);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.response.status).toBe(409);
    }
  });

  it("returns ok for matching idempotent request", () => {
    const now = Date.now();
    const expiresAt = now + 3600000;

    const input = baseParsedInput({
      contentType: "application/json",
      requestedClosed: false,
      ttlSeconds: 3600,
      effectiveExpiresAt: expiresAt,
    });
    const existing = baseStreamMeta({
      content_type: "application/json",
      closed: 0,
      ttl_seconds: 3600,
      expires_at: expiresAt,
    });

    const result = validatePutInput(input, existing);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.kind).toBe("idempotent");
    }
  });

  it("uses existing content-type when request has none", () => {
    const input = baseParsedInput({ contentType: null });
    const existing = baseStreamMeta({ content_type: "application/json" });

    const result = validatePutInput(input, existing);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.kind).toBe("idempotent");
    }
  });
});

describe("validatePutInput (new stream)", () => {
  it("returns ok with create kind when stream does not exist", () => {
    const input = baseParsedInput({ contentType: "text/plain" });

    const result = validatePutInput(input, null);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.kind).toBe("create");
      if (result.value.kind === "create") {
        expect(result.value.contentType).toBe("text/plain");
      }
    }
  });

  it("defaults to application/octet-stream when content-type is missing", () => {
    const input = baseParsedInput({ contentType: null });

    const result = validatePutInput(input, null);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.value.kind).toBe("create");
      if (result.value.kind === "create") {
        expect(result.value.contentType).toBe("application/octet-stream");
      }
    }
  });
});
