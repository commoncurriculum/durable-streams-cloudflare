import { toUint8Array } from "./encoding";
import { buildSegmentKey, encodeSegmentMessages } from "../../../../storage/segments";
import type { StreamStorage } from "../../../../storage/types";
import type { StreamEnv } from "../types";

export type SegmentRotationResult = {
  rotated: boolean;
  segment?: {
    readSeq: number;
    startOffset: number;
    endOffset: number;
    r2Key: string;
    contentType: string;
    createdAt: number;
    expiresAt: number | null;
    sizeBytes: number;
    messageCount: number;
  };
};

// #region docs-rotate-check
export async function rotateSegment(params: {
  env: StreamEnv;
  storage: StreamStorage;
  streamId: string;
  segmentMaxMessages: number;
  segmentMaxBytes: number;
  force?: boolean;
  retainOps?: boolean;
}): Promise<SegmentRotationResult> {
  const {
    env,
    storage,
    streamId,
    segmentMaxMessages,
    segmentMaxBytes,
    force,
    retainOps,
  } = params;

  if (!env.R2) return { rotated: false };

  const meta = await storage.getStream(streamId);
  if (!meta) return { rotated: false };

  const shouldRotate =
    force || meta.segment_messages >= segmentMaxMessages || meta.segment_bytes >= segmentMaxBytes;
  if (!shouldRotate) return { rotated: false };
  // #endregion docs-rotate-check

  const deleteOps = env.R2_DELETE_OPS !== "0" && !retainOps;

  const segmentStart = meta.segment_start;
  const segmentEnd = meta.tail_offset;

  if (segmentEnd <= segmentStart) return { rotated: false };

  const ops = await storage.selectOpsRange(streamId, segmentStart, segmentEnd);
  if (ops.length === 0) return { rotated: false };
  if (ops[0].start_offset !== segmentStart) return { rotated: false };

  for (let i = 1; i < ops.length; i += 1) {
    if (ops[i].start_offset !== ops[i - 1].end_offset) {
      return { rotated: false };
    }
  }

  const resolvedEnd = ops[ops.length - 1].end_offset;
  if (resolvedEnd !== segmentEnd) return { rotated: false };

  // #region docs-rotate-store
  const now = Date.now();
  const messages = ops.map((chunk) => toUint8Array(chunk.body));
  const body = encodeSegmentMessages(messages);
  const sizeBytes = messages.reduce((sum, message) => sum + message.byteLength, 0);
  const messageCount = messages.length;

  const key = buildSegmentKey(streamId, meta.read_seq);
  await env.R2.put(key, body, {
    httpMetadata: { contentType: meta.content_type },
  });

  const expiresAt = meta.expires_at ?? null;
  await storage.insertSegment({
    streamId,
    r2Key: key,
    startOffset: segmentStart,
    endOffset: segmentEnd,
    readSeq: meta.read_seq,
    contentType: meta.content_type,
    createdAt: now,
    expiresAt,
    sizeBytes,
    messageCount,
  });
  // #endregion docs-rotate-store

  const remainingStats = await storage.getOpsStatsFrom(streamId, segmentEnd);
  const batchStatements = [
    storage.updateStreamStatement(
      streamId,
      ["read_seq = ?", "segment_start = ?", "segment_messages = ?", "segment_bytes = ?"],
      [meta.read_seq + 1, segmentEnd, remainingStats.messageCount, remainingStats.sizeBytes],
    ),
  ];
  if (deleteOps) {
    batchStatements.push(storage.deleteOpsThroughStatement(streamId, segmentEnd));
  }
  await storage.batch(batchStatements);

  const segment = {
    readSeq: meta.read_seq,
    startOffset: segmentStart,
    endOffset: segmentEnd,
    r2Key: key,
    contentType: meta.content_type,
    createdAt: now,
    expiresAt,
    sizeBytes,
    messageCount,
  };

  return { rotated: true, segment };
}
