import { errorResponse } from "../shared/errors";
import { HEADER_STREAM_READER_KEY } from "../shared/headers";
import { applyCorsHeaders } from "./cors";
import { getStreamEntry } from "../../storage/registry";
import type { StreamMeta } from "./cache";
import type { ProjectJwtClaims } from "./authentication";

// ============================================================================
// Internal Helpers
// ============================================================================

function wrapAuthorizationError(status: number, error: string, origin: string | null): Response {
  const resp = errorResponse(status, error);
  applyCorsHeaders(resp.headers, origin);
  return resp;
}

async function getStreamMeta(
  kv: KVNamespace | undefined,
  doKey: string,
): Promise<StreamMeta | null> {
  if (!kv) return null;
  const entry = await getStreamEntry(kv, doKey);
  if (!entry) return null;
  return {
    public: entry.public,
    readerKey: entry.readerKey,
  };
}

// ============================================================================
// Hono Middleware
// ============================================================================

// #region docs-authorize-request
/**
 * Stream-scoped auth middleware. Mounted on /v1/stream/*.
 * - Validates projectId/streamPath are present (400)
 * - For reads (GET/HEAD): looks up stream metadata, skips auth if public
 * - For mutations: requires JWT with write/manage scope
 * - Sets `streamMeta` in context on success
 */
// biome-ignore lint: Hono context typing is complex; middleware is wired through the app
export async function authorizationMiddleware(
  c: any,
  next: () => Promise<void>,
): Promise<void | Response> {
  // #region docs-extract-stream-id
  const projectId = c.get("projectId");
  const doKey = c.get("streamPath");
  if (!projectId || !doKey) {
    return errorResponse(400, "missing project or stream id");
  }
  // #endregion docs-extract-stream-id

  const corsOrigin = c.get("corsOrigin");
  const jwtClaims: ProjectJwtClaims | null = c.get("jwtClaims");
  const method = c.req.method.toUpperCase();
  const isStreamRead = method === "GET" || method === "HEAD";

  let streamMeta: StreamMeta | null = null;
  if (isStreamRead) {
    streamMeta = await getStreamMeta(c.env.REGISTRY, doKey);
    if (!streamMeta?.public) {
      if (!jwtClaims) return wrapAuthorizationError(401, "unauthorized", corsOrigin);
    }
  } else {
    if (!jwtClaims) return wrapAuthorizationError(401, "unauthorized", corsOrigin);
    if (jwtClaims.scope !== "write" && jwtClaims.scope !== "manage") {
      return wrapAuthorizationError(403, "forbidden", corsOrigin);
    }
  }

  c.set("streamMeta", streamMeta);

  await next();

  // HEAD responses: include reader key so clients can discover it
  if (method === "HEAD" && c.res?.ok && streamMeta?.readerKey) {
    c.res.headers.set(HEADER_STREAM_READER_KEY, streamMeta.readerKey);
  }
}
// #endregion docs-authorize-request
