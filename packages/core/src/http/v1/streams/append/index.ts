import { errorResponse } from "../../../shared/errors";
import { logWarn } from "../../../../log";
import { DO_STORAGE_QUOTA_BYTES_DEFAULT, LONGPOLL_STAGGER_MS } from "../../../shared/limits";
import { ZERO_OFFSET } from "../shared/offsets";
import { validateContentLength, validateBodySize } from "../shared/body";
import {
  evaluateProducer,
  producerDuplicateResponse,
  type ProducerEval,
} from "../shared/producer";
import { extractPostInput, parsePostInput } from "./parse";
import { validateStreamExists, validatePostInput } from "./validate";
import { executePost } from "./execute";
import {
  broadcastSse,
  broadcastSseControl,
  broadcastWebSocket,
  broadcastWebSocketControl,
  buildPreCacheResponse,
} from "../realtime/handlers";
import type { StreamContext } from "../types";

export { extractPostInput, parsePostInput } from "./parse";
export { validateStreamExists, validatePostInput } from "./validate";
export { executePost } from "./execute";
export { buildAppendBatch } from "./batch";

// #region docs-handle-post
export async function handlePost(
  ctx: StreamContext,
  streamId: string,
  request: Request,
): Promise<Response> {
  return ctx.state.blockConcurrencyWhile(async () => {
    // FIX-004: Reject writes when DO storage is near capacity (90% of quota)
    const quotaBytes = (() => {
      const raw = ctx.env.DO_STORAGE_QUOTA_BYTES;
      const parsed = raw ? Number.parseInt(raw, 10) : NaN;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : DO_STORAGE_QUOTA_BYTES_DEFAULT;
    })();
    const dbSize = ctx.state.storage.sql.databaseSize;
    if (dbSize >= quotaBytes * 0.9) {
      return errorResponse(507, "storage quota exceeded");
    }

    // 1. Validate stream exists
    const doneGetStream = ctx.timing?.start("do.getStream");
    const meta = await ctx.getStream(streamId);
    doneGetStream?.();
    const streamResult = validateStreamExists(meta);
    if (streamResult.kind === "error") return streamResult.response;

    // 2. Extract and parse input
    const raw = await extractPostInput(streamId, request);
    const parsed = parsePostInput(raw);
    if (parsed.kind === "error") return parsed.response;

    // 3. Validate content-length and body size
    const contentLengthResult = validateContentLength(
      request.headers.get("Content-Length"),
      parsed.value.bodyBytes.length,
    );
    if (contentLengthResult.kind === "error") return contentLengthResult.response;
    const bodySizeResult = validateBodySize(parsed.value.bodyBytes.length);
    if (bodySizeResult.kind === "error") return bodySizeResult.response;

    // 4. Evaluate producer FIRST when present (duplicate detection takes priority)
    // Producer dedup must return 204 even if stream is closed — idempotent clients
    // retrying a close request must get the same response.
    let producerEval: ProducerEval = { kind: "none" };
    if (parsed.value.producer) {
      producerEval = await evaluateProducer(ctx.storage, streamId, parsed.value.producer);
      if (producerEval.kind === "error") return producerEval.response;
      if (producerEval.kind === "duplicate") {
        const dupOffset = await ctx.encodeOffset(
          streamId,
          streamResult.value,
          producerEval.state.last_offset,
        );
        return producerDuplicateResponse(producerEval.state, dupOffset, streamResult.value.closed === 1);
      }
    }

    // 5. Validate post operation (checks closed status, content-type, stream-seq)
    // For non-producer requests: closed > content-type > sequence.
    const encodedTailOffset = await ctx.encodeTailOffset(streamId, streamResult.value);
    const validated = validatePostInput(parsed.value, streamResult.value, encodedTailOffset);
    if (validated.kind === "error") return validated.response;
    // #endregion docs-handle-post

    // 6. Execute
    const result = await executePost(ctx, validated.value);
    if (result.kind === "error") return result.response;

    // #region docs-side-effects
    // 7. Side effects (notifications, broadcast, metrics)

    // 7a. Pre-cache long-poll response at waiter URLs BEFORE resolving.
    const waiterUrls = ctx.longPoll.getReadyWaiterUrls(result.value.newTailOffset);
    if (waiterUrls.length > 0) {
      const currentMeta = await ctx.getStream(streamId);
      if (currentMeta) {
        for (const waiterUrl of waiterUrls) {
          try {
            const parsedUrl = new URL(waiterUrl);
            const offsetParam = parsedUrl.searchParams.get("offset");
            const cursor = parsedUrl.searchParams.get("cursor");
            if (!offsetParam) continue;

            const resolved = await ctx.resolveOffset(
              streamId,
              currentMeta,
              offsetParam === "-1" ? ZERO_OFFSET : offsetParam,
            );
            if (resolved.error) continue;

            const preCacheResp = await buildPreCacheResponse(
              ctx, streamId, currentMeta, resolved.offset, cursor,
            );
            if (preCacheResp) {
              await caches.default.put(waiterUrl, preCacheResp);
            }
          } catch (e) {
            logWarn({ streamId, waiterUrl, component: "pre-cache" }, "pre-cache build/store failed", e);
          }
        }
      }
    }

    ctx.longPoll.notify(result.value.newTailOffset, LONGPOLL_STAGGER_MS);

    const writeTimestamp = Date.now();
    const doneBroadcast = ctx.timing?.start("do.broadcast");

    if (validated.value.kind === "close_only") {
      await broadcastSseControl(
        ctx,
        streamId,
        streamResult.value,
        result.value.newTailOffset,
        true,
        writeTimestamp,
      );
      await broadcastWebSocketControl(
        ctx,
        streamId,
        streamResult.value,
        result.value.newTailOffset,
        true,
        writeTimestamp,
      );
    } else {
      await broadcastSse(
        ctx,
        streamId,
        streamResult.value,
        validated.value.contentType,
        result.value.ssePayload,
        result.value.newTailOffset,
        validated.value.closeStream,
        writeTimestamp,
      );
      await broadcastWebSocket(
        ctx,
        streamId,
        streamResult.value,
        validated.value.contentType,
        result.value.ssePayload,
        result.value.newTailOffset,
        validated.value.closeStream,
        writeTimestamp,
      );
    }
    doneBroadcast?.();

    if (result.value.rotateSegment) {
      ctx.state.waitUntil(ctx.rotateSegment(streamId, { force: result.value.forceRotation }));
    }

    // Record metrics for message append
    if (ctx.env.METRICS && validated.value.kind === "append") {
      ctx.env.METRICS.writeDataPoint({
        indexes: [streamId],
        blobs: [streamId, "append", parsed.value.producer?.id ?? "anonymous"],
        doubles: [1, parsed.value.bodyBytes.length],
      });
    }

    // Record metrics for stream close
    if (ctx.env.METRICS && (validated.value.kind === "close_only" || validated.value.closeStream)) {
      ctx.env.METRICS.writeDataPoint({
        indexes: [streamId],
        blobs: [streamId, "close", parsed.value.producer?.id ?? "anonymous"],
        doubles: [1, 0],
      });
    }
    // #endregion docs-side-effects

    return new Response(null, { status: result.value.status, headers: result.value.headers });
  });
}
