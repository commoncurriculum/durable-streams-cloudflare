import { errorResponse } from "../protocol/errors";
import type { StreamContext } from "./context";

const SESSION_STREAM_PREFIX = "subscriptions/";
export const SESSION_ID_HEADER = "X-Session-Id";

export async function ensureReadAuthorized(
  ctx: StreamContext,
  streamId: string,
  request: Request,
): Promise<Response | null> {
  const sessionId = request.headers.get(SESSION_ID_HEADER);
  if (!sessionId) return null;

  if (streamId.startsWith(SESSION_STREAM_PREFIX)) {
    const expected = streamId.slice(SESSION_STREAM_PREFIX.length);
    if (expected !== sessionId) {
      return errorResponse(403, "forbidden");
    }
    return null;
  }

  const allowed = await ctx.storage.hasStreamSubscriber(streamId, sessionId);
  if (!allowed) return errorResponse(403, "forbidden");

  return null;
}
