const DEFAULT_PROJECT_ID = "_default";

/**
 * Parse a raw stream path (everything after `/v1/stream/`) into projectId + streamId.
 * Handles both `projectId/streamId` and legacy `streamId` (maps to `_default` project).
 */
export function parseStreamPath(raw: string): { projectId: string; streamId: string } {
  const i = raw.indexOf("/");
  if (i === -1) return { projectId: DEFAULT_PROJECT_ID, streamId: raw };
  return { projectId: raw.slice(0, i), streamId: raw.slice(i + 1) };
}
