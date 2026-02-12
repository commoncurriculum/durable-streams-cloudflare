import { logWarn } from "../../../../log";
import {
  LONGPOLL_STAGGER_MS,
  DO_STORAGE_QUOTA_BYTES_DEFAULT,
} from "../../../shared/limits";
import { ZERO_OFFSET } from "../shared/offsets";
import { validateBodySize } from "../shared/body";
import {
  HEADER_PRODUCER_EPOCH,
  HEADER_PRODUCER_SEQ,
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_NEXT_OFFSET,
  baseHeaders,
} from "../../../shared/headers";
import { evaluateProducer } from "../shared/producer";
import { buildAppendBatch } from "../../../../storage/append-batch";
import { broadcastSse, broadcastWebSocket } from "../realtime/handlers";
import { buildPreCacheResponse } from "../realtime/handlers";
import type { StreamContext } from "../types";

export type ExecuteAppendOptions = {
  streamId: string;
  payload: Uint8Array;
  streamSeq?: string | null;
  producer?: { id: string; epoch: number; seq: number } | null;
  closeStream?: boolean;
};

export type ExecuteAppendResult = {
  status: 200 | 204;
  headers: Headers;
  newTailOffset: number;
};

/**
 * THE ONE complete append function that does everything.
 *
 * Both HTTP and RPC call this single function.
 */
export async function appendStream(
  ctx: StreamContext,
  opts: ExecuteAppendOptions
): Promise<ExecuteAppendResult> {
  const streamId = opts.streamId;
  const payload = opts.payload;
  const streamSeq = opts.streamSeq ?? null;
  const producer = opts.producer ?? null;
  const closeStream = opts.closeStream ?? false;

  return ctx.state.blockConcurrencyWhile(async () => {
    // 1. Check storage quota (applies to all writes)
    const quotaBytes = (() => {
      const raw = ctx.env.DO_STORAGE_QUOTA_BYTES;
      const parsed = raw ? Number.parseInt(raw, 10) : NaN;
      return Number.isFinite(parsed) && parsed > 0
        ? parsed
        : DO_STORAGE_QUOTA_BYTES_DEFAULT;
    })();
    const dbSize = ctx.state.storage.sql.databaseSize;
    if (dbSize >= quotaBytes * 0.9) {
      throw new Error("Storage quota exceeded");
    }

    // 2. Validate payload size (protects DO from oversized writes)
    const bodySizeResult = validateBodySize(payload.length);
    if (bodySizeResult.kind === "error") {
      throw new Error("Body size too large");
    }

    // 3. Get and validate stream exists
    const doneGetStream = ctx.timing?.start("do.getStream");
    const meta = await ctx.getStream(streamId);
    doneGetStream?.();

    if (!meta) throw new Error("Stream not found");
    if (meta.closed) throw new Error("Stream is closed");

    // 4. Producer deduplication
    const producerEval = producer
      ? await evaluateProducer(ctx.storage, streamId, producer)
      : { kind: "none" as const };

    if (producerEval.kind === "error") {
      throw new Error("Producer evaluation failed");
    }
    if (producerEval.kind === "duplicate") {
      const dupOffset = await ctx.encodeOffset(
        streamId,
        meta,
        producerEval.state.last_offset
      );
      const headers = baseHeaders({
        [HEADER_STREAM_NEXT_OFFSET]: dupOffset,
        [HEADER_PRODUCER_EPOCH]: producerEval.state.epoch.toString(),
        [HEADER_PRODUCER_SEQ]: producerEval.state.last_seq.toString(),
      });
      if (meta.closed === 1) {
        headers.set(HEADER_STREAM_CLOSED, "true");
      }
      return {
        status: 204,
        headers,
        newTailOffset: producerEval.state.last_offset,
      };
    }

    // 5. Pre-cache optimization (before write)
    // Pre-cache responses for long-poll waiters before executing the write
    const waiterUrls = ctx.longPoll.getReadyWaiterUrls(meta.tail_offset);
    for (const waiterUrl of waiterUrls) {
      try {
        const parsedUrl = new URL(waiterUrl);
        const offsetParam = parsedUrl.searchParams.get("offset");
        const cursor = parsedUrl.searchParams.get("cursor");
        if (!offsetParam) continue;

        const resolved = await ctx.resolveOffset(
          streamId,
          meta,
          offsetParam === "-1" ? ZERO_OFFSET : offsetParam
        );
        if (resolved.error) continue;

        const preCacheResp = await buildPreCacheResponse(
          ctx,
          streamId,
          meta,
          resolved.offset,
          cursor
        );
        if (preCacheResp) {
          await caches.default.put(waiterUrl, preCacheResp);
        }
      } catch (e) {
        logWarn(
          { streamId, waiterUrl, component: "pre-cache" },
          "pre-cache build/store failed",
          e
        );
      }
    }

    // 6. Build append batch
    const doneBuild = ctx.timing?.start("append.build");
    const batch = await buildAppendBatch(
      ctx.storage,
      streamId,
      meta.content_type,
      payload,
      {
        streamSeq,
        producer,
        closeStream,
      }
    );
    doneBuild?.();

    if (batch.error) {
      throw new Error("Batch build failed");
    }

    // 7. Execute batch atomically
    const doneBatch = ctx.timing?.start("append.batch");
    await ctx.storage.batch(batch.statements);
    doneBatch?.();

    // 8. Notify long-poll waiters
    ctx.longPoll.notify(batch.newTailOffset, LONGPOLL_STAGGER_MS);

    // 9. Broadcast to live clients
    const writeTimestamp = Date.now();
    const doneBroadcast = ctx.timing?.start("do.broadcast");

    await broadcastSse(
      ctx,
      streamId,
      meta,
      meta.content_type,
      batch.ssePayload,
      batch.newTailOffset,
      closeStream,
      writeTimestamp
    );

    await broadcastWebSocket(
      ctx,
      streamId,
      meta,
      meta.content_type,
      batch.ssePayload,
      batch.newTailOffset,
      closeStream,
      writeTimestamp
    );

    doneBroadcast?.();

    // 10. Schedule segment rotation
    ctx.state.waitUntil(ctx.rotateSegment(streamId, { force: closeStream }));

    // 11. Record metrics
    if (payload.length > 0 && ctx.env.METRICS) {
      ctx.env.METRICS.writeDataPoint({
        indexes: [streamId],
        blobs: [streamId, "append", producer?.id ?? "anonymous"],
        doubles: [1, payload.length],
      });
    }

    if (closeStream && ctx.env.METRICS) {
      ctx.env.METRICS.writeDataPoint({
        indexes: [streamId],
        blobs: [streamId, "close", producer?.id ?? "anonymous"],
        doubles: [1, 0],
      });
    }

    // 12. Build response headers
    const nextOffsetHeader = await ctx.encodeOffset(
      streamId,
      meta,
      batch.newTailOffset
    );
    const headers = baseHeaders({
      [HEADER_STREAM_NEXT_OFFSET]: nextOffsetHeader,
    });

    if (producer) {
      headers.set(HEADER_PRODUCER_EPOCH, producer.epoch.toString());
      headers.set(HEADER_PRODUCER_SEQ, producer.seq.toString());
    }

    if (closeStream) {
      headers.set(HEADER_STREAM_CLOSED, "true");
    }

    const status = producer ? 200 : 204;

    return {
      status,
      headers,
      newTailOffset: batch.newTailOffset,
    };
  });
}
