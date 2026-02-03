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

export function decodeOffset(token: string): number | null {
  const parsed = decodeOffsetParts(token);
  return parsed ? parsed.byteOffset : null;
}

export function decodeOffsetParts(token: string): { readSeq: number; byteOffset: number } | null {
  const match = /^(\d+)_([0-9]+)$/.exec(token);
  if (!match) return null;
  const readSeq = Number(match[1]);
  const byteOffset = Number(match[2]);
  if (!Number.isFinite(readSeq) || !Number.isFinite(byteOffset)) return null;
  if (!Number.isSafeInteger(readSeq) || !Number.isSafeInteger(byteOffset)) return null;
  if (readSeq < 0 || byteOffset < 0) return null;
  return { readSeq, byteOffset };
}
