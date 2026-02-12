import { baseHeaders } from "../../../shared/headers";
import { errorResponse, ErrorCode } from "../../../shared/errors";
import { logWarn } from "../../../../log";
import { deleteStreamEntry } from "../../../../storage/registry";
import type { StreamContext } from "../types";
import { closeAllSseClients, closeAllWebSockets } from "../realtime/handlers";

// #region docs-handle-delete
export async function handleDelete(ctx: StreamContext, streamId: string): Promise<Response> {
  return ctx.state.blockConcurrencyWhile(async () => {
    const doneGetStream = ctx.timing?.start("do.getStream");
    const meta = await ctx.getStream(streamId);
    doneGetStream?.();
    if (!meta) return errorResponse(404, ErrorCode.STREAM_NOT_FOUND, "stream not found");

    const segments = ctx.env.R2 ? await ctx.storage.listSegments(streamId) : [];

    await ctx.storage.deleteStreamData(streamId);
    ctx.longPoll.notifyAll();
    await closeAllSseClients(ctx);
    closeAllWebSockets(ctx);

    // FIX-015: R2 segment deletion with per-segment error handling
    if (ctx.env.R2 && segments.length > 0) {
      const r2 = ctx.env.R2;
      ctx.state.waitUntil(
        Promise.allSettled(
          segments.map(async (segment) => {
            try {
              await r2.delete(segment.r2_key);
            } catch (e) {
              logWarn(
                { streamId, r2Key: segment.r2_key, component: "r2-cleanup" },
                "R2 segment deletion failed",
                e,
              );
            }
          }),
        ),
      );
    }

    // FIX-014: KV metadata cleanup with retry (max 3 attempts, backoff)
    if (ctx.env.REGISTRY) {
      ctx.state.waitUntil(
        (async () => {
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              await deleteStreamEntry(ctx.env.REGISTRY!, streamId);
              return;
            } catch (e) {
              if (attempt === 3) {
                logWarn(
                  { streamId, attempt, component: "kv-cleanup" },
                  "KV delete failed after retries on stream deletion",
                  e,
                );
              } else {
                await new Promise((r) => setTimeout(r, attempt * 100));
              }
            }
          }
        })(),
      );
    }

    // Record metrics for stream deletion
    if (ctx.env.METRICS) {
      ctx.env.METRICS.writeDataPoint({
        indexes: [streamId],
        blobs: [streamId, "delete", "anonymous"],
        doubles: [1, 0],
      });
    }

    return new Response(null, { status: 204, headers: baseHeaders() });
  });
}
// #endregion docs-handle-delete
