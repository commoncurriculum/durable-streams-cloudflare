export const HEADER_STREAM_NEXT_OFFSET = "Stream-Next-Offset";
export const HEADER_STREAM_UP_TO_DATE = "Stream-Up-To-Date";
export const HEADER_STREAM_CLOSED = "Stream-Closed";
export const HEADER_STREAM_CURSOR = "Stream-Cursor";
export const HEADER_STREAM_SEQ = "Stream-Seq";
export const HEADER_STREAM_TTL = "Stream-TTL";
export const HEADER_STREAM_EXPIRES_AT = "Stream-Expires-At";
export const HEADER_PRODUCER_ID = "Producer-Id";
export const HEADER_PRODUCER_EPOCH = "Producer-Epoch";
export const HEADER_PRODUCER_SEQ = "Producer-Seq";
export const HEADER_PRODUCER_EXPECTED_SEQ = "Producer-Expected-Seq";
export const HEADER_PRODUCER_RECEIVED_SEQ = "Producer-Received-Seq";
export const HEADER_SSE_DATA_ENCODING = "Stream-SSE-Data-Encoding";
export const HEADER_STREAM_WRITE_TIMESTAMP = "Stream-Write-Timestamp";

export function baseHeaders(extra: Record<string, string> = {}): Headers {
  const headers = new Headers(extra);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  return headers;
}

export function normalizeContentType(value: string | null): string | null {
  if (!value) return null;
  return value.split(";")[0]?.trim().toLowerCase() ?? null;
}

export function isJsonContentType(value: string): boolean {
  return normalizeContentType(value) === "application/json";
}

export function isTextual(value: string): boolean {
  const normalized = normalizeContentType(value);
  return normalized?.startsWith("text/") || normalized === "application/json";
}
