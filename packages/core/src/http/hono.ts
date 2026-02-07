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
 * @param origin - The allowed origin. Defaults to "*" if not provided.
 *   Supports comma-separated list (e.g., "https://a.com,https://b.com")
 *   matched against the request's Origin header at the call site.
 */
export function applyCorsHeaders(headers: Headers, origin?: string): void {
  headers.set("Access-Control-Allow-Origin", origin || "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS.join(", "));
  headers.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS.join(", "));
}
