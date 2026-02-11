import { describe, it, expect } from "vitest";
import {
  ESTUARY_ID_PATTERN,
  STREAM_ID_PATTERN,
} from "../src/constants";

describe("constants", () => {
  describe("ESTUARY_ID_PATTERN", () => {
    it("matches valid estuary IDs (UUID format)", () => {
      expect(ESTUARY_ID_PATTERN.test("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(true);
      expect(ESTUARY_ID_PATTERN.test("00000000-0000-0000-0000-000000000000")).toBe(true);
      expect(ESTUARY_ID_PATTERN.test("ABCDEF12-3456-7890-ABCD-EF1234567890")).toBe(true);
      expect(ESTUARY_ID_PATTERN.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    });

    it("rejects invalid estuary IDs", () => {
      expect(ESTUARY_ID_PATTERN.test("has space")).toBe(false);
      expect(ESTUARY_ID_PATTERN.test("has'quote")).toBe(false);
      expect(ESTUARY_ID_PATTERN.test('has"doublequote')).toBe(false);
      expect(ESTUARY_ID_PATTERN.test("")).toBe(false);
      expect(ESTUARY_ID_PATTERN.test("has;semicolon")).toBe(false);
      expect(ESTUARY_ID_PATTERN.test("'; DROP TABLE --")).toBe(false);
      expect(ESTUARY_ID_PATTERN.test("abc123")).toBe(false);
      expect(ESTUARY_ID_PATTERN.test("not-a-uuid-format")).toBe(false);
    });
  });

  describe("STREAM_ID_PATTERN", () => {
    it("matches valid stream IDs", () => {
      expect(STREAM_ID_PATTERN.test("stream123")).toBe(true);
      expect(STREAM_ID_PATTERN.test("my-stream")).toBe(true);
      expect(STREAM_ID_PATTERN.test("my_stream")).toBe(true);
      expect(STREAM_ID_PATTERN.test("user:stream:1")).toBe(true);
      expect(STREAM_ID_PATTERN.test("Stream.Name.123")).toBe(true);
    });

    it("rejects invalid stream IDs", () => {
      expect(STREAM_ID_PATTERN.test("has space")).toBe(false);
      expect(STREAM_ID_PATTERN.test("has'quote")).toBe(false);
      expect(STREAM_ID_PATTERN.test('has"doublequote')).toBe(false);
      expect(STREAM_ID_PATTERN.test("")).toBe(false);
      expect(STREAM_ID_PATTERN.test("has;semicolon")).toBe(false);
      expect(STREAM_ID_PATTERN.test("'; DROP TABLE --")).toBe(false);
    });
  });

});
