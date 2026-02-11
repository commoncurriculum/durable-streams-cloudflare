// ============================================================================
// CORS
// ============================================================================

const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Stream-Seq",
  "Stream-TTL",
  "Stream-Expires-At",
  "Stream-Closed",
  "If-None-Match",
  "Producer-Id",
  "Producer-Epoch",
  "Producer-Seq",
  "Authorization",
];

const CORS_EXPOSE_HEADERS = [
  "Stream-Next-Offset",
  "Stream-Cursor",
  "Stream-Up-To-Date",
  "Stream-Closed",
  "ETag",
  "Location",
  "Producer-Epoch",
  "Producer-Seq",
  "Producer-Expected-Seq",
  "Producer-Received-Seq",
  "Stream-SSE-Data-Encoding",
];

/**
 * Apply CORS headers to a response.
 * @param headers - The response headers to modify.
 * @param origin - The allowed origin, or `null` to skip CORS headers entirely.
 */
export function applyCorsHeaders(headers: Headers, origin: string | null): void {
  if (origin === null) return;
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS.join(", "));
  headers.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS.join(", "));
}

/**
 * Parse the CORS_ORIGINS env var (comma-separated) into an array.
 * Returns an empty array when the env var is missing or blank.
 */
export function parseGlobalCorsOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Resolve the CORS origin for a request by merging global and per-project origins.
 * Global origins (from CORS_ORIGINS env var) apply to ALL projects.
 * Returns null (no CORS headers) when no origins are configured at either level.
 * Returns "*" when any origin list includes "*".
 * Returns the matching origin when the request Origin matches a configured origin.
 * Returns null when the request origin doesn't match any configured origin.
 */
export function resolveCorsOrigin(
  projectOrigins: string[] | undefined,
  globalOrigins: string[],
  requestOrigin: string | null,
): string | null {
  const merged = [...globalOrigins, ...(projectOrigins ?? [])];
  if (merged.length === 0) return null;
  if (merged.includes("*")) return "*";
  if (requestOrigin && merged.includes(requestOrigin)) return requestOrigin;
  return null;
}
