// #region docs-encode
import { OFFSET_WIDTH } from "./limits";

export const ZERO_OFFSET = `${"0".repeat(OFFSET_WIDTH)}_${"0".repeat(OFFSET_WIDTH)}`;

export function encodeOffset(offset: number, readSeq = 0): string {
  const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const safeReadSeq = Number.isFinite(readSeq) && readSeq > 0 ? Math.floor(readSeq) : 0;
  return `${String(safeReadSeq).padStart(OFFSET_WIDTH, "0")}_${String(safeOffset).padStart(
    OFFSET_WIDTH,
    "0",
  )}`;
}
// #endregion docs-encode

// #region docs-decode
import { type } from "arktype";
import { regex } from "arkregex";

const OFFSET_PATTERN = regex("^(\\d+)_(\\d+)$");

const offsetToken = type("string").pipe((s, ctx) => {
  const match = OFFSET_PATTERN.exec(s);
  if (!match) return ctx.error("invalid offset format");
  const readSeq = Number(match[1]);
  const byteOffset = Number(match[2]);
  if (!Number.isSafeInteger(readSeq) || !Number.isSafeInteger(byteOffset)) return ctx.error("offset out of safe integer range");
  if (readSeq < 0 || byteOffset < 0) return ctx.error("offset must be non-negative");
  return { readSeq, byteOffset };
});

export function decodeOffset(token: string): number | null {
  const parsed = decodeOffsetParts(token);
  return parsed ? parsed.byteOffset : null;
}

export function decodeOffsetParts(token: string): { readSeq: number; byteOffset: number } | null {
  const result = offsetToken(token);
  if (result instanceof type.errors) return null;
  return result;
}
// #endregion docs-decode
