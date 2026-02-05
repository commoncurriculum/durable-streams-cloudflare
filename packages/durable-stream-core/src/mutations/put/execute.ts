import { buildPutHeaders, buildAppendBatch } from "../../engine/stream";
import { evaluateProducer } from "../../engine/producer";
import type { StreamContext } from "../../http/context";
import type { StreamMeta } from "../../storage/storage";
import type {
  ValidatedPutInput,
  PutExecutionResult,
  Result,
  IdempotentPutInput,
  CreatePutInput,
} from "../types";

/**
 * Execute an idempotent PUT (stream already exists with matching properties).
 * Returns 200 with current stream headers.
 */
export async function executeIdempotentPut(
  ctx: StreamContext,
  input: IdempotentPutInput,
): Promise<Result<PutExecutionResult>> {
  const { existing, streamId } = input;
  const headers = buildPutHeaders(existing, await ctx.encodeTailOffset(streamId, existing));

  return {
    kind: "ok",
    value: {
      status: 200,
      headers,
      rotateSegment: false,
      forceRotation: false,
    },
  };
}

/**
 * Execute PUT to create a new stream.
 * Optionally appends initial data if body is non-empty.
 */
export async function executeNewStream(
  ctx: StreamContext,
  input: CreatePutInput,
): Promise<Result<PutExecutionResult>> {
  const {
    streamId,
    contentType,
    requestedClosed,
    ttlSeconds,
    effectiveExpiresAt,
    bodyBytes,
    streamSeq,
    producer,
    requestUrl,
    now,
  } = input;

  // Insert the stream
  const doneInsert = ctx.timing?.start("stream.insert");
  await ctx.storage.insertStream({
    streamId,
    contentType,
    closed: requestedClosed,
    ttlSeconds,
    expiresAt: effectiveExpiresAt,
    createdAt: now,
  });
  doneInsert?.();

  let tailOffset = 0;

  // Evaluate producer if provided
  // Note: We only check for producer "error", not "duplicate".
  // PUT creates new streams, so true duplicates (same producer ID + seq on same stream)
  // cannot occur. The "error" case handles invalid producer state.
  // Contrast with POST where duplicate detection prevents re-appending the same message.
  if (producer) {
    const producerEval = await evaluateProducer(ctx.storage, streamId, producer);
    if (producerEval.kind === "error") {
      return { kind: "error", response: producerEval.response };
    }
  }

  // Append initial data if body is non-empty
  if (bodyBytes.length > 0) {
    const doneBuild = ctx.timing?.start("append.build");
    const append = await buildAppendBatch(ctx.storage, streamId, contentType, bodyBytes, {
      streamSeq,
      producer,
      closeStream: requestedClosed,
    });
    doneBuild?.();

    if (append.error) {
      return { kind: "error", response: append.error };
    }

    const doneBatch = ctx.timing?.start("append.batch");
    await ctx.storage.batch(append.statements);
    doneBatch?.();
    tailOffset = append.newTailOffset;
  }

  // Build response headers
  const closedBy = requestedClosed && producer ? producer : null;

  const createdMeta: StreamMeta = {
    stream_id: streamId,
    content_type: contentType,
    closed: requestedClosed ? 1 : 0,
    tail_offset: tailOffset,
    read_seq: 0,
    segment_start: 0,
    segment_messages: 0,
    segment_bytes: 0,
    last_stream_seq: null,
    ttl_seconds: ttlSeconds,
    expires_at: effectiveExpiresAt,
    created_at: now,
    closed_at: requestedClosed ? now : null,
    closed_by_producer_id: closedBy?.id ?? null,
    closed_by_epoch: closedBy?.epoch ?? null,
    closed_by_seq: closedBy?.seq ?? null,
  };

  const headers = buildPutHeaders(createdMeta, await ctx.encodeTailOffset(streamId, createdMeta));
  headers.set("Location", requestUrl);

  return {
    kind: "ok",
    value: {
      status: 201,
      headers,
      rotateSegment: true,
      forceRotation: requestedClosed,
    },
  };
}

/**
 * Execute PUT operation based on validated input.
 */
export async function executePut(
  ctx: StreamContext,
  input: ValidatedPutInput,
): Promise<Result<PutExecutionResult>> {
  if (input.kind === "idempotent") {
    return executeIdempotentPut(ctx, input);
  }
  return executeNewStream(ctx, input);
}
