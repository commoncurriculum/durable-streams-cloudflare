import {
  HEADER_PRODUCER_EPOCH,
  HEADER_PRODUCER_SEQ,
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_EXPIRES_AT,
  HEADER_STREAM_NEXT_OFFSET,
  HEADER_STREAM_SEQ,
  HEADER_STREAM_TTL,
  baseHeaders,
  isJsonContentType,
  normalizeContentType,
} from "../../protocol/headers";
import { MAX_APPEND_BYTES } from "../../protocol/limits";
import { parseExpiresAt, parseTtlSeconds, ttlMatches } from "../../protocol/expiry";
import { errorResponse } from "../../protocol/errors";
import { encodeOffset } from "../../protocol/offsets";
import {
  buildAppendBatch,
  buildClosedConflict,
  buildPutHeaders,
  parseContentType,
  validateStreamSeq,
} from "../../engine/stream";
import { closeStreamOnly } from "../../engine/close";
import {
  evaluateProducer,
  parseProducerHeaders,
  producerDuplicateResponse,
  type ProducerEval,
} from "../../engine/producer";
import type { StreamContext } from "../context";
import { broadcastSse, broadcastSseControl, closeAllSseClients } from "./realtime";

export async function handlePut(
  ctx: StreamContext,
  streamId: string,
  request: Request,
): Promise<Response> {
  return ctx.state.blockConcurrencyWhile(async () => {
    const now = Date.now();
    const headerContentType = parseContentType(request);
    const requestedClosed = request.headers.get(HEADER_STREAM_CLOSED) === "true";
    const ttlHeader = request.headers.get(HEADER_STREAM_TTL);
    const expiresHeader = request.headers.get(HEADER_STREAM_EXPIRES_AT);

    if (ttlHeader && expiresHeader) {
      return errorResponse(400, "Stream-TTL and Stream-Expires-At are mutually exclusive");
    }

    const ttlSeconds = parseTtlSeconds(ttlHeader);
    if (ttlSeconds.error) return errorResponse(400, ttlSeconds.error);

    const expiresAt = parseExpiresAt(expiresHeader);
    if (expiresAt.error) return errorResponse(400, expiresAt.error);

    const effectiveExpiresAt =
      ttlSeconds.value !== null ? now + ttlSeconds.value * 1000 : expiresAt.value;

    let bodyBytes = new Uint8Array(await request.arrayBuffer());
    const contentLengthError = validateContentLength(request, bodyBytes);
    if (contentLengthError) return contentLengthError;
    if (bodyBytes.length > MAX_APPEND_BYTES) {
      return errorResponse(413, "payload too large");
    }

    if (
      bodyBytes.length > 0 &&
      isJsonContentType(headerContentType ?? "application/octet-stream")
    ) {
      const text = new TextDecoder().decode(bodyBytes);
      try {
        const value = JSON.parse(text);
        if (Array.isArray(value) && value.length === 0) {
          bodyBytes = new Uint8Array();
        }
      } catch {
        // invalid JSON handled later in append path
      }
    }

    const existing = await ctx.getStream(streamId);
    if (existing) {
      const contentType = headerContentType ?? existing.content_type;
      if (normalizeContentType(existing.content_type) !== contentType) {
        return errorResponse(409, "content-type mismatch");
      }
      if (requestedClosed !== (existing.closed === 1)) {
        return errorResponse(409, "stream closed status mismatch");
      }
      if (!ttlMatches(existing, ttlSeconds.value, effectiveExpiresAt)) {
        return errorResponse(409, "stream TTL/expiry mismatch");
      }

      const headers = buildPutHeaders(existing);
      return new Response(null, { status: 200, headers });
    }

    const contentType = headerContentType ?? "application/octet-stream";

    await ctx.storage.insertStream({
      streamId,
      contentType,
      closed: requestedClosed,
      ttlSeconds: ttlSeconds.value,
      expiresAt: effectiveExpiresAt,
      createdAt: now,
    });

    let tailOffset = 0;

    const producer = parseProducerHeaders(request);
    if (producer && producer.error) return producer.error;

    if (producer?.value) {
      const producerEval = await evaluateProducer(ctx.storage, streamId, producer.value);
      if (producerEval.kind === "error") return producerEval.response;
    }

    if (bodyBytes.length > 0) {
      const append = await buildAppendBatch(ctx.storage, streamId, contentType, bodyBytes, {
        streamSeq: request.headers.get(HEADER_STREAM_SEQ),
        producer: producer?.value ?? null,
        closeStream: requestedClosed,
      });

      if (append.error) return append.error;
      await ctx.storage.batch(append.statements);
      tailOffset = append.newTailOffset;
    }

    const closedBy = requestedClosed && producer?.value ? producer.value : null;

    const headers = buildPutHeaders({
      stream_id: streamId,
      content_type: contentType,
      closed: requestedClosed ? 1 : 0,
      tail_offset: tailOffset,
      last_stream_seq: null,
      ttl_seconds: ttlSeconds.value,
      expires_at: effectiveExpiresAt,
      created_at: now,
      closed_at: requestedClosed ? now : null,
      closed_by_producer_id: closedBy?.id ?? null,
      closed_by_epoch: closedBy?.epoch ?? null,
      closed_by_seq: closedBy?.seq ?? null,
    });
    headers.set("Location", request.url);

    if (requestedClosed) {
      ctx.state.waitUntil(ctx.compactToR2(streamId, { force: true, flushToTail: true }));
    }

    return new Response(null, { status: 201, headers });
  });
}

export async function handlePost(
  ctx: StreamContext,
  streamId: string,
  request: Request,
): Promise<Response> {
  return ctx.state.blockConcurrencyWhile(async () => {
    const meta = await ctx.getStream(streamId);
    if (!meta) return errorResponse(404, "stream not found");

    const closeStream = request.headers.get(HEADER_STREAM_CLOSED) === "true";

    const bodyBytes = new Uint8Array(await request.arrayBuffer());
    const contentLengthError = validateContentLength(request, bodyBytes);
    if (contentLengthError) return contentLengthError;
    if (bodyBytes.length > MAX_APPEND_BYTES) {
      return errorResponse(413, "payload too large");
    }

    const producer = parseProducerHeaders(request);
    if (producer && producer.error) return producer.error;

    let producerEval: ProducerEval = { kind: "none" };
    if (producer?.value) {
      producerEval = await evaluateProducer(ctx.storage, streamId, producer.value);
      if (producerEval.kind === "error") return producerEval.response;
      if (producerEval.kind === "duplicate") {
        return producerDuplicateResponse(producerEval.state, meta.closed === 1);
      }
    }

    if (bodyBytes.length === 0 && closeStream) {
      const closeResult = await closeStreamOnly(ctx.storage, meta, producer?.value);
      if (closeResult.error) return closeResult.error;
      const headers = closeResult.headers;

      ctx.longPoll.notify(meta.tail_offset);
      await broadcastSseControl(ctx, meta.tail_offset, true);
      ctx.state.waitUntil(ctx.compactToR2(streamId, { force: true, flushToTail: true }));
      return new Response(null, { status: 204, headers });
    }

    if (bodyBytes.length === 0) {
      return errorResponse(400, "empty body");
    }

    if (meta.closed === 1) {
      return buildClosedConflict(meta);
    }

    const contentType = parseContentType(request);
    if (!contentType) {
      return errorResponse(400, "Content-Type is required");
    }

    if (normalizeContentType(meta.content_type) !== contentType) {
      return errorResponse(409, "content-type mismatch");
    }

    const streamSeq = request.headers.get(HEADER_STREAM_SEQ);
    const seqError = validateStreamSeq(meta, streamSeq);
    if (seqError) return seqError;

    const append = await buildAppendBatch(ctx.storage, streamId, contentType, bodyBytes, {
      streamSeq,
      producer: producer?.value ?? null,
      closeStream,
    });

    if (append.error) return append.error;

    await ctx.storage.batch(append.statements);

    const headers = baseHeaders({
      [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(append.newTailOffset),
    });

    if (producer?.value) {
      headers.set(HEADER_PRODUCER_EPOCH, producer.value.epoch.toString());
      headers.set(HEADER_PRODUCER_SEQ, producer.value.seq.toString());
    }

    if (closeStream) headers.set(HEADER_STREAM_CLOSED, "true");

    ctx.longPoll.notify(append.newTailOffset);
    broadcastSse(ctx, contentType, append.ssePayload, append.newTailOffset, closeStream);
    ctx.state.waitUntil(
      ctx.compactToR2(streamId, { force: closeStream, flushToTail: closeStream }),
    );

    const status = producer?.value ? 200 : 204;
    return new Response(null, { status, headers });
  });
}

export async function handleDelete(ctx: StreamContext, streamId: string): Promise<Response> {
  return ctx.state.blockConcurrencyWhile(async () => {
    const meta = await ctx.getStream(streamId);
    if (!meta) return errorResponse(404, "stream not found");

    const snapshots = ctx.env.R2 ? await ctx.storage.listSnapshots(streamId) : [];

    await ctx.storage.deleteStreamData(streamId);
    ctx.longPoll.notifyAll();
    await closeAllSseClients(ctx);

    if (ctx.env.R2 && snapshots.length > 0) {
      ctx.state.waitUntil(
        Promise.all(snapshots.map((snapshot) => ctx.env.R2!.delete(snapshot.r2_key))).then(
          () => undefined,
        ),
      );
    }

    return new Response(null, { status: 204, headers: baseHeaders() });
  });
}

function validateContentLength(request: Request, body: Uint8Array): Response | null {
  const header = request.headers.get("Content-Length");
  if (!header) return null;
  const expected = Number.parseInt(header, 10);
  if (!Number.isFinite(expected)) {
    return errorResponse(400, "invalid Content-Length");
  }
  if (expected !== body.length) {
    return errorResponse(400, "content-length mismatch");
  }
  return null;
}
