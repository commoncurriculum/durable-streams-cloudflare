import type { StreamEnv } from "../http/context";

type AdminSegment = {
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

export function recordAdminSegment(
  state: DurableObjectState,
  env: StreamEnv,
  streamId: string,
  segment: AdminSegment,
): void {
  if (!env.ADMIN_DB) return;
  const db = env.ADMIN_DB;
  state.waitUntil(
    db
      .prepare(
        `
          INSERT INTO segments_admin (
            stream_id,
            read_seq,
            start_offset,
            end_offset,
            r2_key,
            content_type,
            created_at,
            expires_at,
            size_bytes,
            message_count
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .bind(
        streamId,
        segment.readSeq,
        segment.startOffset,
        segment.endOffset,
        segment.r2Key,
        segment.contentType,
        segment.createdAt,
        segment.expiresAt,
        segment.sizeBytes,
        segment.messageCount,
      )
      .run(),
  );
}
