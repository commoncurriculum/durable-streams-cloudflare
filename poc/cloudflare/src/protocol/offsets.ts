import { OFFSET_WIDTH } from "./limits";

export function encodeOffset(offset: number): string {
  if (offset < 0) return "0".repeat(OFFSET_WIDTH);
  return offset.toString(16).toUpperCase().padStart(OFFSET_WIDTH, "0");
}

export function decodeOffset(token: string): number | null {
  if (!/^[0-9a-fA-F]+$/.test(token)) return null;
  const parsed = parseInt(token, 16);
  if (Number.isNaN(parsed)) return null;
  return parsed;
}
