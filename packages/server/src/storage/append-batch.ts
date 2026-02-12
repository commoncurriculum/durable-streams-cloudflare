import { isJsonContentType } from "../http/shared/headers";
import { errorResponse } from "../http/shared/errors";
import {
  buildJsonArray,
  parseJsonMessages,
} from "../http/v1/streams/shared/json";
import {
  concatBuffers,
  toUint8Array,
} from "../http/v1/streams/shared/encoding";
import type { StorageStatement, StreamStorage } from "./types";

export type AppendResult = {
  statements: StorageStatement[];
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
  }
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

  const statements: StorageStatement[] = [];
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
    messages = [
      { body: bodyBytes.slice().buffer, sizeBytes: bodyBytes.byteLength },
    ];
  }

  let tailOffset = meta.tail_offset;
  const isJson = isJsonContentType(contentType);
  const messageCount = isJson ? messages.length : 1;
  const byteCount = messages.reduce(
    (sum, message) => sum + message.sizeBytes,
    0
  );

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const messageStart = tailOffset;
    const messageEnd = isJson
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
      })
    );

    tailOffset = messageEnd;
  }

  const updateFields: string[] = ["tail_offset = ?"];
  const updateValues: unknown[] = [tailOffset];

  if (opts.streamSeq) {
    updateFields.push("last_stream_seq = ?");
    updateValues.push(opts.streamSeq);
  }

  updateFields.push(
    "segment_messages = segment_messages + ?",
    "segment_bytes = segment_bytes + ?"
  );
  updateValues.push(messageCount, byteCount);

  if (opts.closeStream) {
    updateFields.push("closed = 1", "closed_at = ?");
    updateValues.push(now);
    if (opts.producer) {
      updateFields.push(
        "closed_by_producer_id = ?",
        "closed_by_epoch = ?",
        "closed_by_seq = ?"
      );
      updateValues.push(
        opts.producer.id,
        opts.producer.epoch,
        opts.producer.seq
      );
    } else {
      updateFields.push(
        "closed_by_producer_id = NULL",
        "closed_by_epoch = NULL",
        "closed_by_seq = NULL"
      );
    }
  }

  statements.push(
    storage.updateStreamStatement(streamId, updateFields, updateValues)
  );

  if (opts.producer) {
    statements.push(
      storage.producerUpsertStatement(streamId, opts.producer, tailOffset, now)
    );
  }

  const ssePayload = isJson
    ? buildJsonArray(messages)
    : messages.length === 1
    ? messages[0].body
    : concatBuffers(messages.map((msg) => toUint8Array(msg.body)));

  return { statements, newTailOffset: tailOffset, ssePayload };
}
