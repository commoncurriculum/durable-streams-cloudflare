export interface StreamRecord {
  stream_id: string;
  content_type: string;
  created_at: number;
  deleted_at: number | null;
}

export interface SegmentRecord {
  stream_id: string;
  read_seq: number;
  start_offset: string;
  end_offset: string;
  r2_key: string;
  content_type: string;
  created_at: number;
  expires_at: number | null;
  size_bytes: number;
  message_count: number;
}

export interface StreamListOptions {
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
}

export async function listStreams(
  db: D1Database,
  options: StreamListOptions = {},
): Promise<{ streams: StreamRecord[]; total: number }> {
  const { limit = 100, offset = 0, includeDeleted = false } = options;

  const whereClause = includeDeleted ? "" : "WHERE deleted_at IS NULL";

  const countResult = await db
    .prepare(`SELECT COUNT(*) as count FROM streams ${whereClause}`)
    .first<{ count: number }>();

  const result = await db
    .prepare(
      `SELECT * FROM streams ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(limit, offset)
    .all<StreamRecord>();

  return {
    streams: result.results,
    total: countResult?.count ?? 0,
  };
}

export async function getStream(
  db: D1Database,
  streamId: string,
): Promise<StreamRecord | null> {
  const result = await db
    .prepare("SELECT * FROM streams WHERE stream_id = ?")
    .bind(streamId)
    .first<StreamRecord>();
  return result ?? null;
}

export async function getStreamSegments(
  db: D1Database,
  streamId: string,
): Promise<SegmentRecord[]> {
  const result = await db
    .prepare("SELECT * FROM segments_admin WHERE stream_id = ? ORDER BY read_seq ASC")
    .bind(streamId)
    .all<SegmentRecord>();
  return result.results;
}

export async function getStreamStats(
  db: D1Database,
): Promise<{
  totalStreams: number;
  activeStreams: number;
  deletedStreams: number;
  totalSegments: number;
  totalSizeBytes: number;
}> {
  const [streamsCount, segmentsStats] = await Promise.all([
    db
      .prepare(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) as deleted
        FROM streams`,
      )
      .first<{ total: number; active: number; deleted: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as size FROM segments_admin`,
      )
      .first<{ count: number; size: number }>(),
  ]);

  return {
    totalStreams: streamsCount?.total ?? 0,
    activeStreams: streamsCount?.active ?? 0,
    deletedStreams: streamsCount?.deleted ?? 0,
    totalSegments: segmentsStats?.count ?? 0,
    totalSizeBytes: segmentsStats?.size ?? 0,
  };
}
