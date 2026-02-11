import {
  HEADER_PRODUCER_EPOCH,
  HEADER_PRODUCER_SEQ,
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_NEXT_OFFSET,
  baseHeaders,
} from "../../protocol/headers";
import { buildAppendBatch } from "./batch";
import { closeStreamOnly } from "../close";
import type { StreamContext } from "../../http/router";
import type {
  ValidatedPostInput,
  PostExecutionResult,
  Result,
  CloseOnlyPostInput,
  AppendPostInput,
} from "../types";

/**
 * Execute a close-only operation (empty body with close flag).
 */
export async function executeCloseOnly(
  ctx: StreamContext,
  input: CloseOnlyPostInput,
): Promise<Result<PostExecutionResult>> {
  const { meta, producer } = input;

  const doneClose = ctx.timing?.start("stream.close");
  const closeResult = await closeStreamOnly(ctx.storage, meta, producer ?? undefined);
  doneClose?.();

  if (closeResult.error) {
    return { kind: "error", response: closeResult.error };
  }

  return {
    kind: "ok",
    value: {
      status: 204,
      headers: closeResult.headers,
      newTailOffset: meta.tail_offset,
      ssePayload: null,
      rotateSegment: true,
      forceRotation: true,
    },
  };
}

/**
 * Execute an append operation.
 */
export async function executeAppend(
  ctx: StreamContext,
  input: AppendPostInput,
): Promise<Result<PostExecutionResult>> {
  const { streamId, contentType, bodyBytes, streamSeq, producer, closeStream, meta } = input;

  // Build append batch
  const doneBuild = ctx.timing?.start("append.build");
  const append = await buildAppendBatch(ctx.storage, streamId, contentType, bodyBytes, {
    streamSeq,
    producer,
    closeStream,
  });
  doneBuild?.();

  if (append.error) {
    return { kind: "error", response: append.error };
  }

  // Execute batch
  const doneBatch = ctx.timing?.start("append.batch");
  await ctx.storage.batch(append.statements);
  doneBatch?.();

  // Build response headers
  const nextOffsetHeader = await ctx.encodeOffset(streamId, meta, append.newTailOffset);
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

  // 200 when producer exists (response includes X-Producer-Seq header)
  // 204 No Content when no producer tracking
  const status = producer ? 200 : 204;

  return {
    kind: "ok",
    value: {
      status,
      headers,
      newTailOffset: append.newTailOffset,
      ssePayload: append.ssePayload,
      rotateSegment: true,
      forceRotation: closeStream,
      messageCount: 1,
      bodyLength: bodyBytes.length,
    },
  };
}

/**
 * Execute POST operation based on validated input.
 */
export async function executePost(
  ctx: StreamContext,
  input: ValidatedPostInput,
): Promise<Result<PostExecutionResult>> {
  if (input.kind === "close_only") {
    return executeCloseOnly(ctx, input);
  }
  return executeAppend(ctx, input);
}
