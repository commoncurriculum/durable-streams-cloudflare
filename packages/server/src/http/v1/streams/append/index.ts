import { logWarn } from "../../../../log";
import { LONGPOLL_STAGGER_MS, DO_STORAGE_QUOTA_BYTES_DEFAULT } from "../../../shared/limits";
import { ZERO_OFFSET } from "../shared/offsets";
import { validateBodySize } from "../shared/body";
import {
  HEADER_PRODUCER_EPOCH,
  HEADER_PRODUCER_SEQ,
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_NEXT_OFFSET,
  baseHeaders,
  normalizeContentType,
} from "../../../shared/headers";
import { HttpError } from "../../../shared/errors";
import { evaluateProducer } from "../shared/producer";
import { validateStreamSeq, buildClosedConflict } from "../shared/close";
import { buildAppendBatch } from "../../../../storage/append-batch";
import { broadcastSse, broadcastWebSocket } from "../realtime/handlers";
import { buildPreCacheResponse } from "../realtime/handlers";
import type { StreamContext } from "../types";

export type ExecuteAppendOptions = {
  streamId: string;
  payload: Uint8Array;
  contentType?: string | null;
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
 *
 * IMPORTANT: This function throws HttpError for validation failures.
 * Callers MUST wrap it inside blockConcurrencyWhile with a try/catch
 * INSIDE the callback, so the BCW callback never rejects (which would
 * break the DO's input gate). See block-concurrency-error.test.ts for proof.
 */
export async function appendStream(
  ctx: StreamContext,
  opts: ExecuteAppendOptions,
): Promise<ExecuteAppendResult> {
  const streamId = opts.streamId;
  const payload = opts.payload;
  const requestContentType = opts.contentType ?? null;
  const streamSeq = opts.streamSeq ?? null;
  const producer = opts.producer ?? null;
  const closeStream = opts.closeStream ?? false;

  // 1. Check storage quota (applies to all writes)
  const quotaBytes = (() => {
    const raw = ctx.env.DO_STORAGE_QUOTA_BYTES;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DO_STORAGE_QUOTA_BYTES_DEFAULT;
  })();
  const dbSize = ctx.state.storage.sql.databaseSize;
  if (dbSize >= quotaBytes * 0.9) {
    throw new HttpError(507, "Storage quota exceeded");
  }

  // 2. Validate payload size (protects DO from oversized writes)
  const bodySizeResult = validateBodySize(payload.length);
  if (bodySizeResult.kind === "error") {
    throw new HttpError(413, "Body size too large");
  }

  // 3. Get and validate stream exists
  const doneGetStream = ctx.timing?.start("do.getStream");
  const meta = await ctx.getStream(streamId);
  doneGetStream?.();

  if (!meta) throw new HttpError(404, "stream not found");

  // =========================================================================
  // Handle already-closed streams with nuanced responses
  // =========================================================================
  if (meta.closed) {
    const isCloseOnly = payload.length === 0 && closeStream;
    const isCloseWithBody = payload.length > 0 && closeStream;

    if (isCloseOnly) {
      // Close-only on already-closed stream → idempotent 204
      // Content-type validation is skipped for close-only operations.
      if (producer) {
        const producerEvalClose = await evaluateProducer(ctx.storage, streamId, producer);

        if (producerEvalClose.kind === "error") {
          throw new HttpError(
            producerEvalClose.response.status,
            "Producer evaluation failed",
            producerEvalClose.response,
          );
        }

        if (producerEvalClose.kind === "duplicate") {
          const dupOffset = await ctx.encodeOffset(
            streamId,
            meta,
            producerEvalClose.state.last_offset,
          );
          const headers = baseHeaders({
            [HEADER_STREAM_NEXT_OFFSET]: dupOffset,
            [HEADER_PRODUCER_EPOCH]: producerEvalClose.state.epoch.toString(),
            [HEADER_PRODUCER_SEQ]: producerEvalClose.state.last_seq.toString(),
            [HEADER_STREAM_CLOSED]: "true",
          });
          return {
            status: 204,
            headers,
            newTailOffset: producerEvalClose.state.last_offset,
          };
        }
      }

      // No producer, or producer eval was "none"/"ok" → idempotent 204
      const nextOffset = await ctx.encodeTailOffset(streamId, meta);
      const headers = baseHeaders({
        [HEADER_STREAM_NEXT_OFFSET]: nextOffset,
        [HEADER_STREAM_CLOSED]: "true",
      });
      if (producer) {
        headers.set(HEADER_PRODUCER_EPOCH, producer.epoch.toString());
        headers.set(HEADER_PRODUCER_SEQ, producer.seq.toString());
      }
      return {
        status: 204,
        headers,
        newTailOffset: meta.tail_offset,
      };
    }

    if (isCloseWithBody) {
      // Close with body on already-closed stream → check for producer dedup
      if (producer) {
        const producerEval = await evaluateProducer(ctx.storage, streamId, producer);

        if (producerEval.kind === "error") {
          throw new HttpError(
            producerEval.response.status,
            "Producer evaluation failed",
            producerEval.response,
          );
        }

        if (producerEval.kind === "duplicate") {
          const dupOffset = await ctx.encodeOffset(streamId, meta, producerEval.state.last_offset);
          const headers = baseHeaders({
            [HEADER_STREAM_NEXT_OFFSET]: dupOffset,
            [HEADER_PRODUCER_EPOCH]: producerEval.state.epoch.toString(),
            [HEADER_PRODUCER_SEQ]: producerEval.state.last_seq.toString(),
            [HEADER_STREAM_CLOSED]: "true",
          });
          return {
            status: 204,
            headers,
            newTailOffset: producerEval.state.last_offset,
          };
        }
      }

      // Not a duplicate → 409 with Stream-Closed header
      const nextOffset = await ctx.encodeTailOffset(streamId, meta);
      throw new HttpError(409, "stream is closed", buildClosedConflict(meta, nextOffset));
    }

    // Regular append (no closeStream flag) to closed stream → 409 with headers
    const nextOffset = await ctx.encodeTailOffset(streamId, meta);
    throw new HttpError(409, "stream is closed", buildClosedConflict(meta, nextOffset));
  }

  // =========================================================================
  // Stream is NOT closed — normal append/close path
  // =========================================================================

  // 3a. Validate content-type matches stream (if provided)
  // Skip content-type validation for close-only operations (empty body + closeStream)
  const isCloseOnly = payload.length === 0 && closeStream;
  if (
    !isCloseOnly &&
    requestContentType &&
    normalizeContentType(meta.content_type) !== normalizeContentType(requestContentType)
  ) {
    throw new HttpError(409, "content-type mismatch");
  }

  // 4. Producer deduplication (moved BEFORE Stream-Seq validation so that
  //    duplicate detection takes priority over Stream-Seq regression checks)
  const producerEval = producer
    ? await evaluateProducer(ctx.storage, streamId, producer)
    : { kind: "none" as const };

  if (producerEval.kind === "error") {
    throw new HttpError(
      producerEval.response.status,
      "Producer evaluation failed",
      producerEval.response,
    );
  }
  if (producerEval.kind === "duplicate") {
    const dupOffset = await ctx.encodeOffset(streamId, meta, producerEval.state.last_offset);
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

  // 3b. Validate Stream-Seq ordering (only for non-duplicate writes)
  if (streamSeq) {
    const seqResult = validateStreamSeq(meta, streamSeq);
    if (seqResult.kind === "error") {
      throw new HttpError(409, "Stream-Seq regression", seqResult.response);
    }
  }

  // 3c. Handle close-only (empty body + Stream-Closed: true)
  if (payload.length === 0 && closeStream) {
    // Producer duplicate was already handled above. For "ok"/"none", proceed
    // with closing the stream.

    // Close the stream
    await ctx.storage.closeStream(
      streamId,
      Date.now(),
      producer ? { id: producer.id, epoch: producer.epoch, seq: producer.seq } : null,
    );

    if (producer) {
      await ctx.storage.upsertProducer(streamId, producer, meta.tail_offset, Date.now());
    }

    // Notify waiters
    ctx.longPoll.notifyAll();

    // Record metrics
    if (ctx.env.METRICS) {
      ctx.env.METRICS.writeDataPoint({
        indexes: [streamId],
        blobs: [streamId, "close", producer?.id ?? "anonymous"],
        doubles: [1, 0],
      });
    }

    const nextOffsetHeader = await ctx.encodeTailOffset(streamId, meta);
    const headers = baseHeaders({
      [HEADER_STREAM_NEXT_OFFSET]: nextOffsetHeader,
      [HEADER_STREAM_CLOSED]: "true",
    });

    if (producer) {
      headers.set(HEADER_PRODUCER_EPOCH, producer.epoch.toString());
      headers.set(HEADER_PRODUCER_SEQ, producer.seq.toString());
    }

    return {
      status: 204,
      headers,
      newTailOffset: meta.tail_offset,
    };
  }

  // 3d. Reject empty body without close
  if (payload.length === 0) {
    throw new HttpError(400, "empty body");
  }

  // 3e. Reject missing Content-Type on POST
  if (!requestContentType) {
    throw new HttpError(400, "Content-Type is required");
  }

  // (Producer dedup already handled above — skip old step 4)

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
        offsetParam === "-1" ? ZERO_OFFSET : offsetParam,
      );
      if (resolved.error) continue;

      const preCacheResp = await buildPreCacheResponse(
        ctx,
        streamId,
        meta,
        resolved.offset,
        cursor,
      );
      if (preCacheResp) {
        await caches.default.put(waiterUrl, preCacheResp);
      }
    } catch (e) {
      logWarn({ streamId, waiterUrl, component: "pre-cache" }, "pre-cache build/store failed", e);
    }
  }

  // 6. Build append batch
  const doneBuild = ctx.timing?.start("append.build");
  const batch = await buildAppendBatch(ctx.storage, streamId, meta.content_type, payload, {
    streamSeq,
    producer,
    closeStream,
  });
  doneBuild?.();

  if (batch.error) {
    throw new HttpError(batch.error.status, "Batch build failed", batch.error);
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
    writeTimestamp,
  );

  await broadcastWebSocket(
    ctx,
    streamId,
    meta,
    meta.content_type,
    batch.ssePayload,
    batch.newTailOffset,
    closeStream,
    writeTimestamp,
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
  const nextOffsetHeader = await ctx.encodeOffset(streamId, meta, batch.newTailOffset);
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
}
