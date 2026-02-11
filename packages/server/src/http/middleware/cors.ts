import { cors } from "hono/cors";

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

// ============================================================================
// Hono Middleware
// ============================================================================

// biome-ignore lint: Hono context typing is complex; middleware is wired through the app
export async function corsMiddleware(c: any, next: () => Promise<void>): Promise<void | Response> {
  const projectConfig = c.get("projectConfig");
  const globalOrigins = parseGlobalCorsOrigins(c.env.CORS_ORIGINS);
  let corsOrigin = resolveCorsOrigin(projectConfig?.corsOrigins, globalOrigins, c.req.header("Origin") ?? null);

  // ?public=true implies wildcard CORS when no origins are configured
  if (!corsOrigin && new URL(c.req.url).searchParams.get("public") === "true") {
    corsOrigin = "*";
  }

  c.set("corsOrigin", corsOrigin);

  // If no corsOrigin is configured, skip CORS entirely
  if (!corsOrigin) {
    return next();
  }

  // Use Hono's built-in CORS middleware
  const corsHandler = cors({
    origin: corsOrigin === "*" ? "*" : corsOrigin,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
    allowHeaders: CORS_ALLOW_HEADERS,
    exposeHeaders: CORS_EXPOSE_HEADERS,
  });

  return corsHandler(c, next);
}
