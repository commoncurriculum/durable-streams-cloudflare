import { baseHeaders } from "../../protocol/headers";
import { errorResponse } from "../../protocol/errors";
import {
  evaluateProducer,
  producerDuplicateResponse,
  type ProducerEval,
} from "../../stream/producer";
import type { StreamContext } from "../router";
import { broadcastSse, broadcastSseControl, closeAllSseClients } from "./realtime";

// PUT operations
import { extractPutInput, parsePutInput } from "../../stream/create/parse";
import { validateContentLength, validateBodySize } from "../../stream/shared";
import { validatePutInput } from "../../stream/create/validate";
import { executePut } from "../../stream/create/execute";

// POST operations
import { extractPostInput, parsePostInput } from "../../stream/append/parse";
import { validateStreamExists, validatePostInput } from "../../stream/append/validate";
import { executePost } from "../../stream/append/execute";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate request body constraints (Content-Length header and body size).
 */
function validateRequestBody(
  request: Request,
  bodyLength: number,
): Response | null {
  const contentLengthResult = validateContentLength(
    request.headers.get("Content-Length"),
    bodyLength,
  );
  if (contentLengthResult.kind === "error") return contentLengthResult.response;
  const bodySizeResult = validateBodySize(bodyLength);
  if (bodySizeResult.kind === "error") return bodySizeResult.response;
  return null;
}

/**
 * Schedule segment rotation as a background task if needed.
 */
function scheduleSegmentRotation(
  ctx: StreamContext,
  streamId: string,
  result: { rotateSegment?: boolean; forceRotation?: boolean },
): void {
  if (result.rotateSegment) {
    ctx.state.waitUntil(ctx.rotateSegment(streamId, { force: result.forceRotation }));
  }
}

export async function handlePut(
  ctx: StreamContext,
  streamId: string,
  request: Request,
): Promise<Response> {
  return ctx.state.blockConcurrencyWhile(async () => {
    const now = Date.now();

    // 1. Extract raw input and validate content-length against original body
    const raw = await extractPutInput(streamId, request);
    const bodyError = validateRequestBody(request, raw.bodyBytes.length);
    if (bodyError) return bodyError;

    // 2. Parse (normalizes body, e.g. empty JSON arrays become empty bytes)
    const parsed = parsePutInput(raw, now);
    if (parsed.kind === "error") return parsed.response;

    // 3. Validate against existing stream
    const existing = await ctx.getStream(streamId);
    const validated = validatePutInput(parsed.value, existing);
    if (validated.kind === "error") return validated.response;

    // 4. Execute
    const result = await executePut(ctx, validated.value);
    if (result.kind === "error") return result.response;

    // 5. Side effects (segment rotation)
    scheduleSegmentRotation(ctx, streamId, result.value);

    return new Response(null, { status: result.value.status, headers: result.value.headers });
  });
}

export async function handlePost(
  ctx: StreamContext,
  streamId: string,
  request: Request,
): Promise<Response> {
  return ctx.state.blockConcurrencyWhile(async () => {
    // 1. Validate stream exists
    const meta = await ctx.getStream(streamId);
    const streamResult = validateStreamExists(meta);
    if (streamResult.kind === "error") return streamResult.response;

    // 2. Extract and parse input
    const raw = await extractPostInput(streamId, request);
    const parsed = parsePostInput(raw);
    if (parsed.kind === "error") return parsed.response;

    // 3. Validate content-length and body size
    const bodyError = validateRequestBody(request, parsed.value.bodyBytes.length);
    if (bodyError) return bodyError;

    // 4. Evaluate producer (for duplicate detection)
    // POST evaluates producer BEFORE validation to enable early duplicate detection.
    // This differs from PUT (which defers to execute) because:
    // 1. POST appends to existing streams where duplicates are common
    // 2. PUT creates streams, so duplicates only occur on retry of the same creation
    // 3. Early detection in POST avoids unnecessary validation work
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

    // 5. Validate post operation
    const encodedTailOffset = await ctx.encodeTailOffset(streamId, streamResult.value);
    const validated = validatePostInput(parsed.value, streamResult.value, encodedTailOffset);
    if (validated.kind === "error") return validated.response;

    // 6. Execute
    const result = await executePost(ctx, validated.value);
    if (result.kind === "error") return result.response;

    // 7. Side effects (notifications, broadcast, metrics)
    ctx.longPoll.notify(result.value.newTailOffset);

    if (validated.value.kind === "close_only") {
      await broadcastSseControl(
        ctx,
        streamId,
        streamResult.value,
        result.value.newTailOffset,
        true,
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
      );
    }

    scheduleSegmentRotation(ctx, streamId, result.value);

    // Record metrics for message append
    if (ctx.env.METRICS && validated.value.kind === "append") {
      ctx.env.METRICS.writeDataPoint({
        indexes: [streamId],
        blobs: [streamId, parsed.value.producer?.id ?? "anonymous"],
        doubles: [1, parsed.value.bodyBytes.length],
      });
    }

    return new Response(null, { status: result.value.status, headers: result.value.headers });
  });
}

export async function handleDelete(ctx: StreamContext, streamId: string): Promise<Response> {
  return ctx.state.blockConcurrencyWhile(async () => {
    const meta = await ctx.getStream(streamId);
    if (!meta) return errorResponse(404, "stream not found");

    const segments = ctx.env.R2 ? await ctx.storage.listSegments(streamId) : [];

    await ctx.storage.deleteStreamData(streamId);
    ctx.longPoll.notifyAll();
    await closeAllSseClients(ctx);

    if (ctx.env.R2 && segments.length > 0) {
      const r2 = ctx.env.R2; // Narrowed to non-null by conditional
      ctx.state.waitUntil(
        Promise.all(segments.map((segment) => r2.delete(segment.r2_key))).then(
          () => undefined,
        ),
      );
    }

    if (ctx.env.ADMIN_DB) {
      ctx.state.waitUntil(
        ctx.env.ADMIN_DB.prepare("DELETE FROM segments_admin WHERE stream_id = ?")
          .bind(streamId)
          .run(),
      );
    }

    return new Response(null, { status: 204, headers: baseHeaders() });
  });
}
