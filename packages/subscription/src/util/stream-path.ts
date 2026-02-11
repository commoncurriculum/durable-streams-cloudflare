const DEFAULT_PROJECT_ID = "_default";

export const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

const STREAM_PATH_RE = /\/v1\/stream\/(.+)$/;

export type ParsedStreamPath = {
  projectId: string;
  streamId: string;
  path: string;
};

/**
 * Parse a raw stream path (everything after `/v1/stream/`) into projectId, streamId,
 * and the canonical `projectId/streamId` key used as the DO name and KV key.
 * Handles both `projectId/streamId` and legacy `streamId` (maps to `_default` project).
 */
export function parseStreamPath(raw: string): ParsedStreamPath {
  const i = raw.indexOf("/");
  if (i === -1)
    return {
      projectId: DEFAULT_PROJECT_ID,
      streamId: raw,
      path: `${DEFAULT_PROJECT_ID}/${raw}`,
    };
  const projectId = raw.slice(0, i);
  const streamId = raw.slice(i + 1);
  return { projectId, streamId, path: `${projectId}/${streamId}` };
}

/**
 * Extract and parse a stream path from a URL pathname.
 * Returns null if the pathname doesn't match `/v1/stream/...`, or if the
 * project ID is invalid, or if decoding fails.
 */
export function parseStreamPathFromUrl(
  pathname: string
): ParsedStreamPath | null {
  const m = STREAM_PATH_RE.exec(pathname);
  if (!m) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  const parsed = parseStreamPath(decoded);
  if (!PROJECT_ID_PATTERN.test(parsed.projectId)) return null;
  return parsed;
}
