import { isJsonContentType } from "../../http/shared/headers";
import { errorResponse, ErrorCode } from "../../http/shared/errors";
import { buildJsonArray, parseJsonMessages } from "../../http/v1/streams/shared/json";
import { concatBuffers, toUint8Array } from "../../http/v1/streams/shared/encoding";
import type { BatchOperation, StreamMetaUpdate, StreamStorage } from "./types";

export type AppendResult = {
  statements: BatchOperation[];
  newTailOffset: number;
  ssePayload: ArrayBuffer | null;
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
      error: errorResponse(404, ErrorCode.STREAM_NOT_FOUND, "stream not found"),
    };
  }

  const operations: BatchOperation[] = [];
  const now = Date.now();

  let messages: Array<{ body: ArrayBuffer; sizeBytes: number }> = [];

  if (isJsonContentType(contentType)) {
    const parsed = parseJsonMessages(bodyBytes);
    if (parsed.error) {
      return {
        statements: [],
        newTailOffset: 0,
        ssePayload: null,
        error: errorResponse(400, ErrorCode.INVALID_JSON, parsed.error),
      };
    }
    if (parsed.emptyArray) {
      return {
        statements: [],
        newTailOffset: 0,
        ssePayload: null,
        error: errorResponse(400, ErrorCode.EMPTY_JSON_ARRAY, "empty JSON array is not allowed"),
      };
    }
    messages = parsed.messages;
  } else {
    if (bodyBytes.length === 0) {
      return {
        statements: [],
        newTailOffset: 0,
        ssePayload: null,
        error: errorResponse(400, ErrorCode.EMPTY_BODY, "empty body"),
      };
    }
    messages = [
      {
        body: bodyBytes.slice().buffer as ArrayBuffer,
        sizeBytes: bodyBytes.byteLength,
      },
    ];
  }

  let tailOffset = meta.tail_offset;
  const isJson = isJsonContentType(contentType);
  const messageCount = isJson ? messages.length : 1;
  const byteCount = messages.reduce((sum, message) => sum + message.sizeBytes, 0);

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const messageStart = tailOffset;
    const messageEnd = isJson ? messageStart + 1 : messageStart + message.sizeBytes;

    operations.push(
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

  const metaUpdate: StreamMetaUpdate = {
    tail_offset: tailOffset,
    segment_messages_increment: messageCount,
    segment_bytes_increment: byteCount,
  };

  if (opts.streamSeq) {
    metaUpdate.last_stream_seq = opts.streamSeq;
  }

  if (opts.closeStream) {
    metaUpdate.closed = 1;
    metaUpdate.closed_at = now;
    if (opts.producer) {
      metaUpdate.closed_by_producer_id = opts.producer.id;
      metaUpdate.closed_by_epoch = opts.producer.epoch;
      metaUpdate.closed_by_seq = opts.producer.seq;
    } else {
      metaUpdate.closed_by_producer_id = null;
      metaUpdate.closed_by_epoch = null;
      metaUpdate.closed_by_seq = null;
    }
  }

  operations.push(storage.updateStreamMetaStatement(streamId, metaUpdate));

  if (opts.producer) {
    operations.push(storage.producerUpsertStatement(streamId, opts.producer, tailOffset, now));
  }

  const ssePayload = isJson
    ? buildJsonArray(messages)
    : messages.length === 1
      ? messages[0].body
      : concatBuffers(messages.map((msg) => toUint8Array(msg.body)));

  return { statements: operations, newTailOffset: tailOffset, ssePayload };
}
