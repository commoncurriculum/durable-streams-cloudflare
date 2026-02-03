import {
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_CURSOR,
  HEADER_STREAM_NEXT_OFFSET,
  HEADER_STREAM_UP_TO_DATE,
  baseHeaders,
  isJsonContentType,
  normalizeContentType,
} from "../protocol/headers";
import { errorResponse } from "../protocol/errors";
import { buildEtag } from "../protocol/etag";
import { buildJsonArray, emptyJsonArray, parseJsonMessages } from "../protocol/json";
import { encodeOffset } from "../protocol/offsets";
import { concatBuffers, toUint8Array } from "../protocol/encoding";
import { cacheControlFor, applyExpiryHeaders } from "../protocol/expiry";
import type { StreamMeta, StreamStorage } from "../storage/storage";

export type AppendResult = {
  statements: D1PreparedStatement[];
  newTailOffset: number;
  ssePayload: ArrayBuffer | null;
  error?: Response;
};

export type ReadResult = {
  body: ArrayBuffer;
  nextOffset: number;
  upToDate: boolean;
  closedAtTail: boolean;
  hasData: boolean;
  error?: Response;
};

export async function buildAppendBatch(
  storage: StreamStorage,
  streamId: string,
  contentType: string,
  bodyBytes: Uint8Array,
  opts: {
    streamSeq: string | null;
    producer: { id: string; epoch: number; seq: number } | null;
    closeStream: boolean;
  },
): Promise<AppendResult> {
  const meta = await storage.getStream(streamId);
  if (!meta) {
    return {
      statements: [],
      newTailOffset: 0,
      ssePayload: null,
      error: errorResponse(404, "stream not found"),
    };
  }

  const statements: D1PreparedStatement[] = [];
  const now = Date.now();

  let messages: Array<{ body: ArrayBuffer; sizeBytes: number }> = [];

  if (isJsonContentType(contentType)) {
    const parsed = parseJsonMessages(bodyBytes);
    if (parsed.error) {
      return {
        statements: [],
        newTailOffset: 0,
        ssePayload: null,
        error: errorResponse(400, parsed.error),
      };
    }
    if (parsed.emptyArray) {
      return {
        statements: [],
        newTailOffset: 0,
        ssePayload: null,
        error: errorResponse(400, "empty JSON array is not allowed"),
      };
    }
    messages = parsed.messages;
  } else {
    if (bodyBytes.length === 0) {
      return {
        statements: [],
        newTailOffset: 0,
        ssePayload: null,
        error: errorResponse(400, "empty body"),
      };
    }
    messages = [{ body: bodyBytes.slice().buffer, sizeBytes: bodyBytes.byteLength }];
  }

  let tailOffset = meta.tail_offset;

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const messageStart = tailOffset;
    const messageEnd = isJsonContentType(contentType)
      ? messageStart + 1
      : messageStart + message.sizeBytes;

    statements.push(
      storage.insertOpStatement({
        streamId,
        startOffset: messageStart,
        endOffset: messageEnd,
        sizeBytes: message.sizeBytes,
        streamSeq: opts.streamSeq ?? null,
        producerId: opts.producer?.id ?? null,
        producerEpoch: opts.producer?.epoch ?? null,
        producerSeq: opts.producer?.seq ?? null,
        body: message.body,
        createdAt: now,
      }),
    );

    tailOffset = messageEnd;
  }

  const updateFields: string[] = ["tail_offset = ?"];
  const updateValues: unknown[] = [tailOffset];

  if (opts.streamSeq) {
    updateFields.push("last_stream_seq = ?");
    updateValues.push(opts.streamSeq);
  }

  if (opts.closeStream) {
    updateFields.push("closed = 1", "closed_at = ?");
    updateValues.push(now);
    if (opts.producer) {
      updateFields.push("closed_by_producer_id = ?", "closed_by_epoch = ?", "closed_by_seq = ?");
      updateValues.push(opts.producer.id, opts.producer.epoch, opts.producer.seq);
    } else {
      updateFields.push(
        "closed_by_producer_id = NULL",
        "closed_by_epoch = NULL",
        "closed_by_seq = NULL",
      );
    }
  }

  statements.push(storage.updateStreamStatement(streamId, updateFields, updateValues));

  if (opts.producer) {
    statements.push(storage.producerUpsertStatement(streamId, opts.producer, tailOffset, now));
  }

  const ssePayload = isJsonContentType(contentType)
    ? buildJsonArray(messages)
    : messages.length === 1
      ? messages[0].body
      : concatBuffers(messages.map((msg) => toUint8Array(msg.body)));

  return { statements, newTailOffset: tailOffset, ssePayload };
}

export function buildClosedConflict(meta: StreamMeta): Response {
  const headers = baseHeaders({
    [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(meta.tail_offset),
    [HEADER_STREAM_CLOSED]: "true",
  });
  return new Response("stream is closed", { status: 409, headers });
}

export function buildHeadResponse(meta: StreamMeta): Response {
  const headers = baseHeaders({
    "Content-Type": meta.content_type,
    [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(meta.tail_offset),
    "Cache-Control": "no-store",
  });

  if (meta.closed === 1) headers.set(HEADER_STREAM_CLOSED, "true");
  applyExpiryHeaders(headers, meta);

  return new Response(null, { status: 200, headers });
}

export function buildReadResponse(params: {
  streamId: string;
  meta: StreamMeta;
  body: ArrayBuffer;
  nextOffset: number;
  upToDate: boolean;
  closedAtTail: boolean;
  includeCursor?: string | null;
  offset: number;
}): Response {
  const headers = baseHeaders({
    "Content-Type": params.meta.content_type,
    [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(params.nextOffset),
  });

  if (params.upToDate) headers.set(HEADER_STREAM_UP_TO_DATE, "true");
  if (params.closedAtTail) headers.set(HEADER_STREAM_CLOSED, "true");
  if (params.includeCursor) headers.set(HEADER_STREAM_CURSOR, params.includeCursor);

  applyExpiryHeaders(headers, params.meta);

  const etag = buildEtag(
    params.streamId,
    params.offset,
    params.nextOffset,
    params.meta.closed === 1,
  );
  headers.set("ETag", etag);
  headers.set("Cache-Control", cacheControlFor(params.meta));

  return new Response(params.body, { status: 200, headers });
}

export function buildNowResponse(meta: StreamMeta): Response {
  const headers = baseHeaders({
    "Content-Type": meta.content_type,
    [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(meta.tail_offset),
  });
  headers.set("Cache-Control", "no-store");
  headers.set(HEADER_STREAM_UP_TO_DATE, "true");
  if (meta.closed === 1) headers.set(HEADER_STREAM_CLOSED, "true");
  applyExpiryHeaders(headers, meta);
  const body = isJsonContentType(meta.content_type) ? emptyJsonArray() : null;
  return new Response(body, { status: 200, headers });
}

export async function readFromOffset(
  storage: StreamStorage,
  streamId: string,
  meta: StreamMeta,
  offset: number,
  maxChunkBytes: number,
): Promise<ReadResult> {
  const chunks: Array<{
    start_offset: number;
    end_offset: number;
    size_bytes: number;
    body: ArrayBuffer | Uint8Array | string | number[];
  }> = [];

  if (offset > 0) {
    const overlap = await storage.selectOverlap(streamId, offset);

    if (overlap) {
      if (isJsonContentType(meta.content_type) && overlap.start_offset !== offset) {
        return {
          body: new ArrayBuffer(0),
          nextOffset: offset,
          upToDate: false,
          closedAtTail: false,
          hasData: false,
          error: errorResponse(400, "invalid offset"),
        };
      }
      const sliceStart = offset - overlap.start_offset;
      const source = toUint8Array(overlap.body);
      const slice = source.slice(sliceStart);
      chunks.push({
        start_offset: offset,
        end_offset: overlap.end_offset,
        size_bytes: slice.byteLength,
        body: slice,
      });
    }
  }

  const rows = await storage.selectOpsFrom(streamId, offset);
  let bytes = chunks.reduce((sum, chunk) => sum + chunk.size_bytes, 0);

  for (const row of rows) {
    if (bytes + row.size_bytes > maxChunkBytes && bytes > 0) break;
    const body = toUint8Array(row.body);
    chunks.push({
      start_offset: row.start_offset,
      end_offset: row.end_offset,
      size_bytes: row.size_bytes,
      body,
    });
    bytes += row.size_bytes;
    if (bytes >= maxChunkBytes) break;
  }

  if (chunks.length === 0) {
    const upToDate = offset === meta.tail_offset;
    const closedAtTail = meta.closed === 1 && upToDate;
    if (isJsonContentType(meta.content_type)) {
      const empty = emptyJsonArray();
      return { body: empty, nextOffset: offset, upToDate, closedAtTail, hasData: false };
    }
    return {
      body: new ArrayBuffer(0),
      nextOffset: offset,
      upToDate,
      closedAtTail,
      hasData: false,
    };
  }

  const nextOffset = chunks[chunks.length - 1].end_offset;
  const upToDate = nextOffset === meta.tail_offset;
  const closedAtTail = meta.closed === 1 && upToDate;

  let body: ArrayBuffer;
  if (isJsonContentType(meta.content_type)) {
    body = buildJsonArray(
      chunks.map((chunk) => ({ body: chunk.body, sizeBytes: chunk.size_bytes })),
    );
  } else {
    body = concatBuffers(chunks.map((chunk) => toUint8Array(chunk.body)));
  }

  return { body, nextOffset, upToDate, closedAtTail, hasData: true };
}

export function readFromMessages(params: {
  messages: Uint8Array[];
  contentType: string;
  offset: number;
  maxChunkBytes: number;
  tailOffset: number;
  closed: boolean;
  segmentStart?: number;
}): ReadResult {
  const {
    messages,
    contentType,
    offset,
    maxChunkBytes,
    tailOffset,
    closed,
    segmentStart = 0,
  } = params;
  const chunks: Array<{ body: Uint8Array; sizeBytes: number }> = [];

  if (isJsonContentType(contentType)) {
    const relativeOffset = offset - segmentStart;
    if (relativeOffset < 0 || relativeOffset > messages.length) {
      return {
        body: new ArrayBuffer(0),
        nextOffset: offset,
        upToDate: false,
        closedAtTail: false,
        hasData: false,
        error: errorResponse(400, "invalid offset"),
      };
    }

    let bytes = 0;
    for (let i = relativeOffset; i < messages.length; i += 1) {
      const message = messages[i];
      if (bytes + message.byteLength > maxChunkBytes && bytes > 0) break;
      chunks.push({ body: message, sizeBytes: message.byteLength });
      bytes += message.byteLength;
      if (bytes >= maxChunkBytes) break;
    }

    if (chunks.length === 0) {
      const upToDate = offset === tailOffset;
      const closedAtTail = closed && upToDate;
      return { body: emptyJsonArray(), nextOffset: offset, upToDate, closedAtTail, hasData: false };
    }

    const nextOffset = offset + chunks.length;
    const upToDate = nextOffset === tailOffset;
    const closedAtTail = closed && upToDate;
    return {
      body: buildJsonArray(
        chunks.map((chunk) => ({ body: chunk.body, sizeBytes: chunk.sizeBytes })),
      ),
      nextOffset,
      upToDate,
      closedAtTail,
      hasData: true,
    };
  }

  let bytes = 0;
  let cursor = segmentStart;
  for (const message of messages) {
    const end = cursor + message.byteLength;
    if (end <= offset) {
      cursor = end;
      continue;
    }

    let sliceStart = 0;
    if (offset > cursor) {
      sliceStart = offset - cursor;
    }

    let slice = message.slice(sliceStart);
    if (bytes + slice.byteLength > maxChunkBytes && bytes > 0) break;
    if (bytes + slice.byteLength > maxChunkBytes) {
      slice = slice.slice(0, maxChunkBytes - bytes);
    }
    chunks.push({ body: slice, sizeBytes: slice.byteLength });
    bytes += slice.byteLength;
    cursor = end;
    if (bytes >= maxChunkBytes) break;
  }

  if (chunks.length === 0) {
    const upToDate = offset === tailOffset;
    const closedAtTail = closed && upToDate;
    return {
      body: new ArrayBuffer(0),
      nextOffset: offset,
      upToDate,
      closedAtTail,
      hasData: false,
    };
  }

  const nextOffset = offset + bytes;
  const upToDate = nextOffset === tailOffset;
  const closedAtTail = closed && upToDate;

  return {
    body: concatBuffers(chunks.map((chunk) => chunk.body)),
    nextOffset,
    upToDate,
    closedAtTail,
    hasData: true,
  };
}

export function parseContentType(request: Request): string | null {
  return normalizeContentType(request.headers.get("Content-Type"));
}

export function validateStreamSeq(meta: StreamMeta, streamSeq: string | null): Response | null {
  if (streamSeq && meta.last_stream_seq && streamSeq <= meta.last_stream_seq) {
    return errorResponse(409, "Stream-Seq regression");
  }
  return null;
}

export function buildPutHeaders(meta: StreamMeta): Headers {
  const headers = baseHeaders({
    "Content-Type": meta.content_type,
    [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(meta.tail_offset),
  });
  applyExpiryHeaders(headers, meta);
  if (meta.closed === 1) headers.set(HEADER_STREAM_CLOSED, "true");
  return headers;
}

export function buildLongPollHeaders(params: {
  meta: StreamMeta;
  nextOffset: number;
  upToDate: boolean;
  closedAtTail: boolean;
  cursor: string | null;
}): Headers {
  const headers = baseHeaders({
    "Content-Type": params.meta.content_type,
    [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(params.nextOffset),
  });
  if (params.cursor) headers.set(HEADER_STREAM_CURSOR, params.cursor);
  if (params.upToDate) headers.set(HEADER_STREAM_UP_TO_DATE, "true");
  if (params.closedAtTail) headers.set(HEADER_STREAM_CLOSED, "true");
  applyExpiryHeaders(headers, params.meta);
  return headers;
}
