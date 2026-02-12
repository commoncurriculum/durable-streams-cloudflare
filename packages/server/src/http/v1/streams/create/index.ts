import { DO_STORAGE_QUOTA_BYTES_DEFAULT } from "../../../shared/limits";
import {
  parseExpiresAt,
  parseTtlSeconds,
  applyExpiryHeaders,
  ttlMatches,
} from "../../../shared/expiry";
import {
  normalizeContentType,
  isJsonContentType,
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_NEXT_OFFSET,
  baseHeaders,
} from "../../../shared/headers";
import { HttpError } from "../../../shared/errors";
import { validateBodySize } from "../shared/body";
import { buildAppendBatch } from "../../../../storage/append-batch";
import { evaluateProducer } from "../shared/producer";
import type { StreamContext } from "../types";
import type { StreamMeta } from "../../../../storage";

export type CreateStreamOptions = {
  streamId: string;
  contentType?: string | null;
  payload?: Uint8Array | null;
  streamSeq?: string | null;
  producer?: { id: string; epoch: number; seq: number } | null;
  closeStream?: boolean;
  isPublic?: boolean;
  ttlHeader?: string | null;
  expiresHeader?: string | null;
  requestUrl?: string;
};

export type CreateStreamResult = {
  status: 200 | 201;
  headers: Headers;
};

/**
 * THE ONE complete create function that does everything.
 *
 * Both HTTP and RPC call this single function.
 */
export async function createStream(
  ctx: StreamContext,
  opts: CreateStreamOptions
): Promise<CreateStreamResult> {
  const streamId = opts.streamId;
  const contentTypeRaw = opts.contentType ?? null;
  const payload = opts.payload ?? new Uint8Array();
  const streamSeq = opts.streamSeq ?? null;
  const producer = opts.producer ?? null;
  const closeStream = opts.closeStream ?? false;
  const isPublic = opts.isPublic ?? false;
  const ttlHeader = opts.ttlHeader ?? null;
  const expiresHeader = opts.expiresHeader ?? null;
  const requestUrl = opts.requestUrl ?? "";
  const now = Date.now();

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
    throw new HttpError(507, "Storage quota exceeded");
  }

  // 2. Validate payload size (protects DO from oversized writes)
  const bodySizeResult = validateBodySize(payload.length);
  if (bodySizeResult.kind === "error") {
    throw new HttpError(413, "Body size too large");
  }

  // 3. Parse and validate TTL/expiry headers
  if (ttlHeader && expiresHeader) {
    throw new HttpError(
      400,
      "Stream-TTL and Stream-Expires-At are mutually exclusive"
    );
  }

  const ttlSeconds = parseTtlSeconds(ttlHeader);
  if (ttlSeconds.error) {
    throw new HttpError(400, ttlSeconds.error);
  }

  const expiresAt = parseExpiresAt(expiresHeader);
  if (expiresAt.error) {
    throw new HttpError(400, expiresAt.error);
  }

  const effectiveExpiresAt =
    ttlSeconds.value !== null ? now + ttlSeconds.value * 1000 : expiresAt.value;

  // 4. Normalize body for empty JSON arrays
  let bodyBytes = payload;
  if (
    bodyBytes.length > 0 &&
    contentTypeRaw != null &&
    isJsonContentType(contentTypeRaw)
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

  // 5. Check if stream already exists
  const doneGetStream = ctx.timing?.start("do.getStream");
  const existing = await ctx.getStream(streamId);
  doneGetStream?.();

  if (existing) {
    // IDEMPOTENT PATH: Stream already exists, validate it matches
    const contentType = contentTypeRaw ?? existing.content_type;

    // Content-type must match
    if (
      normalizeContentType(existing.content_type) !==
      normalizeContentType(contentType)
    ) {
      throw new HttpError(409, "content-type mismatch");
    }

    // Closed status must match
    if (closeStream !== (existing.closed === 1)) {
      throw new HttpError(409, "stream closed status mismatch");
    }

    // TTL/expiry must match
    if (!ttlMatches(existing, ttlSeconds.value, effectiveExpiresAt)) {
      throw new HttpError(409, "stream TTL/expiry mismatch");
    }

    // Return 200 with existing stream headers
    const nextOffsetHeader = await ctx.encodeTailOffset(streamId, existing);
    const headers = baseHeaders({
      "Content-Type": existing.content_type,
      [HEADER_STREAM_NEXT_OFFSET]: nextOffsetHeader,
    });
    applyExpiryHeaders(headers, existing);
    if (existing.closed === 1) {
      headers.set(HEADER_STREAM_CLOSED, "true");
    }

    return { status: 200, headers };
  }

  // 6. CREATE PATH: New stream

  // Default to application/octet-stream when Content-Type is omitted
  const contentType = contentTypeRaw ?? "application/octet-stream";

  // 7. Insert the stream
  const doneInsert = ctx.timing?.start("stream.insert");
  await ctx.storage.insertStream({
    streamId,
    contentType,
    closed: closeStream,
    isPublic,
    ttlSeconds: ttlSeconds.value,
    expiresAt: effectiveExpiresAt,
    createdAt: now,
  });
  doneInsert?.();

  let tailOffset = 0;

  // 8. Evaluate producer if provided
  if (producer) {
    const producerEval = await evaluateProducer(
      ctx.storage,
      streamId,
      producer
    );
    if (producerEval.kind === "error") {
      throw new HttpError(
        producerEval.response.status,
        "Producer evaluation failed",
        producerEval.response
      );
    }
    // Note: We don't check for "duplicate" on PUT/create because the stream is brand new
  }

  // 9. Append initial data if body is non-empty
  if (bodyBytes.length > 0) {
    const doneBuild = ctx.timing?.start("append.build");
    const batch = await buildAppendBatch(
      ctx.storage,
      streamId,
      contentType,
      bodyBytes,
      {
        streamSeq,
        producer,
        closeStream,
      }
    );
    doneBuild?.();

    if (batch.error) {
      throw new HttpError(
        batch.error.status,
        "Batch build failed",
        batch.error
      );
    }

    const doneBatch = ctx.timing?.start("append.batch");
    await ctx.storage.batch(batch.statements);
    doneBatch?.();
    tailOffset = batch.newTailOffset;
  }

  // 10. Schedule segment rotation
  ctx.state.waitUntil(ctx.rotateSegment(streamId, { force: closeStream }));

  // 11. Record metrics for stream creation
  if (ctx.env.METRICS) {
    ctx.env.METRICS.writeDataPoint({
      indexes: [streamId],
      blobs: [streamId, "create", producer?.id ?? "anonymous"],
      doubles: [1, bodyBytes.length],
    });
  }

  // 12. Build response headers
  const closedBy = closeStream && producer ? producer : null;
  const createdMeta: StreamMeta = {
    stream_id: streamId,
    content_type: contentType,
    closed: closeStream ? 1 : 0,
    tail_offset: tailOffset,
    read_seq: 0,
    segment_start: 0,
    segment_messages: 0,
    segment_bytes: 0,
    last_stream_seq: null,
    ttl_seconds: ttlSeconds.value,
    expires_at: effectiveExpiresAt,
    created_at: now,
    closed_at: closeStream ? now : null,
    closed_by_producer_id: closedBy?.id ?? null,
    closed_by_epoch: closedBy?.epoch ?? null,
    closed_by_seq: closedBy?.seq ?? null,
    public: isPublic ? 1 : 0,
  };

  const nextOffsetHeader = await ctx.encodeTailOffset(streamId, createdMeta);
  const headers = baseHeaders({
    "Content-Type": createdMeta.content_type,
    [HEADER_STREAM_NEXT_OFFSET]: nextOffsetHeader,
  });
  applyExpiryHeaders(headers, createdMeta);
  if (closeStream) {
    headers.set(HEADER_STREAM_CLOSED, "true");
  }
  if (requestUrl) {
    headers.set("Location", requestUrl);
  }

  return { status: 201, headers };
}
