import type {
  CreateStreamInput,
  ProducerState,
  ReadChunk,
  OpsStats,
  SegmentInput,
  SegmentRecord,
  StorageStatement,
  StreamMeta,
  StreamStorage,
} from "./types";

type SqlStorage = DurableObjectStorage["sql"];

export class DoSqliteStorage implements StreamStorage {
  constructor(private sql: SqlStorage) {}

  initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS stream_meta (
        stream_id TEXT PRIMARY KEY,
        content_type TEXT NOT NULL,
        closed INTEGER NOT NULL DEFAULT 0,
        tail_offset INTEGER NOT NULL DEFAULT 0,
        read_seq INTEGER NOT NULL DEFAULT 0,
        segment_start INTEGER NOT NULL DEFAULT 0,
        segment_messages INTEGER NOT NULL DEFAULT 0,
        segment_bytes INTEGER NOT NULL DEFAULT 0,
        last_stream_seq TEXT,
        ttl_seconds INTEGER,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        closed_by_producer_id TEXT,
        closed_by_epoch INTEGER,
        closed_by_seq INTEGER
      );

      CREATE TABLE IF NOT EXISTS producers (
        producer_id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL,
        last_seq INTEGER NOT NULL,
        last_offset INTEGER NOT NULL,
        last_updated INTEGER
      );

      CREATE TABLE IF NOT EXISTS ops (
        start_offset INTEGER PRIMARY KEY,
        end_offset INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        stream_seq TEXT,
        producer_id TEXT,
        producer_epoch INTEGER,
        producer_seq INTEGER,
        body BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ops_start_offset ON ops(start_offset);

      CREATE TABLE IF NOT EXISTS segments (
        read_seq INTEGER PRIMARY KEY,
        r2_key TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        size_bytes INTEGER NOT NULL,
        message_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS segments_start_offset ON segments(start_offset);
    `);

    // Migration: add public column to stream_meta
    try {
      this.sql.exec(`ALTER TABLE stream_meta ADD COLUMN public INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists
    }
  }

  async batch(statements: StorageStatement[]): Promise<void> {
    for (const statement of statements) {
      this.sql.exec(statement.sql, ...statement.args);
    }
  }

  async getStream(_streamId: string): Promise<StreamMeta | null> {
    const rows = this.sql.exec<StreamMeta>("SELECT * FROM stream_meta LIMIT 1").toArray();
    return rows[0] ?? null;
  }

  async insertStream(input: CreateStreamInput): Promise<void> {
    this.sql.exec(
      `
        INSERT INTO stream_meta (
          stream_id,
          content_type,
          closed,
          tail_offset,
          read_seq,
          segment_start,
          segment_messages,
          segment_bytes,
          last_stream_seq,
          ttl_seconds,
          expires_at,
          created_at,
          closed_at,
          closed_by_producer_id,
          closed_by_epoch,
          closed_by_seq,
          public
        )
        VALUES (?, ?, ?, 0, 0, 0, 0, 0, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
      `,
      input.streamId,
      input.contentType,
      input.closed ? 1 : 0,
      input.ttlSeconds,
      input.expiresAt,
      input.createdAt,
      input.isPublic ? 1 : 0,
    );
  }

  async closeStream(
    _streamId: string,
    closedAt: number,
    closedBy?: { id: string; epoch: number; seq: number } | null,
  ): Promise<void> {
    if (closedBy) {
      this.sql.exec(
        `
          UPDATE stream_meta
          SET closed = 1,
              closed_at = ?,
              closed_by_producer_id = ?,
              closed_by_epoch = ?,
              closed_by_seq = ?
        `,
        closedAt,
        closedBy.id,
        closedBy.epoch,
        closedBy.seq,
      );
      return;
    }

    this.sql.exec(
      `
        UPDATE stream_meta
        SET closed = 1,
            closed_at = ?,
            closed_by_producer_id = NULL,
            closed_by_epoch = NULL,
            closed_by_seq = NULL
      `,
      closedAt,
    );
  }

  async deleteStreamData(_streamId: string): Promise<void> {
    this.sql.exec("DELETE FROM segments");
    this.sql.exec("DELETE FROM ops");
    this.sql.exec("DELETE FROM producers");
    this.sql.exec("DELETE FROM stream_meta");
  }

  async getProducer(_streamId: string, producerId: string): Promise<ProducerState | null> {
    const result = this.sql.exec<ProducerState>(
      "SELECT * FROM producers WHERE producer_id = ?",
      producerId,
    );
    const rows = result.toArray();
    return rows[0] ?? null;
  }

  producerUpsertStatement(
    _streamId: string,
    producer: { id: string; epoch: number; seq: number },
    lastOffset: number,
    lastUpdated: number,
  ): StorageStatement {
    return {
      sql: `
        INSERT INTO producers (producer_id, epoch, last_seq, last_offset, last_updated)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(producer_id) DO UPDATE SET
          epoch = excluded.epoch,
          last_seq = excluded.last_seq,
          last_offset = excluded.last_offset,
          last_updated = excluded.last_updated
      `,
      args: [producer.id, producer.epoch, producer.seq, lastOffset, lastUpdated],
    };
  }

  async upsertProducer(
    streamId: string,
    producer: { id: string; epoch: number; seq: number },
    lastOffset: number,
    lastUpdated: number,
  ): Promise<void> {
    await this.batch([this.producerUpsertStatement(streamId, producer, lastOffset, lastUpdated)]);
  }

  async deleteProducer(_streamId: string, producerId: string): Promise<void> {
    this.sql.exec("DELETE FROM producers WHERE producer_id = ?", producerId);
  }

  insertOpStatement(input: {
    streamId: string;
    startOffset: number;
    endOffset: number;
    sizeBytes: number;
    streamSeq: string | null;
    producerId: string | null;
    producerEpoch: number | null;
    producerSeq: number | null;
    body: ArrayBuffer;
    createdAt: number;
  }): StorageStatement {
    return {
      sql: `
        INSERT INTO ops (
          start_offset,
          end_offset,
          size_bytes,
          stream_seq,
          producer_id,
          producer_epoch,
          producer_seq,
          body,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        input.startOffset,
        input.endOffset,
        input.sizeBytes,
        input.streamSeq,
        input.producerId,
        input.producerEpoch,
        input.producerSeq,
        input.body,
        input.createdAt,
      ],
    };
  }

  updateStreamStatement(
    _streamId: string,
    updateFields: string[],
    updateValues: unknown[],
  ): StorageStatement {
    return {
      sql: `UPDATE stream_meta SET ${updateFields.join(", ")}`,
      args: updateValues,
    };
  }

  async selectOverlap(_streamId: string, offset: number): Promise<ReadChunk | null> {
    const result = this.sql.exec<{
      start_offset: number;
      end_offset: number;
      size_bytes: number;
      body: ArrayBuffer | string | number | null;
      created_at: number;
    }>(
      `
        SELECT start_offset, end_offset, size_bytes, body, created_at
        FROM ops
        WHERE start_offset < ? AND end_offset > ?
        ORDER BY start_offset DESC
        LIMIT 1
      `,
      offset,
      offset,
    );
    const rows = result.toArray();
    return rows[0] ? (rows[0] as ReadChunk) : null;
  }

  async selectOpsFrom(_streamId: string, offset: number): Promise<ReadChunk[]> {
    const result = this.sql.exec<{
      start_offset: number;
      end_offset: number;
      size_bytes: number;
      body: ArrayBuffer | string | number | null;
      created_at: number;
    }>(
      `
        SELECT start_offset, end_offset, size_bytes, body, created_at
        FROM ops
        WHERE start_offset >= ?
        ORDER BY start_offset ASC
        LIMIT 200
      `,
      offset,
    );
    return result.toArray() as ReadChunk[];
  }

  async selectOpsRange(
    _streamId: string,
    startOffset: number,
    endOffset: number,
  ): Promise<ReadChunk[]> {
    const result = this.sql.exec<{
      start_offset: number;
      end_offset: number;
      size_bytes: number;
      body: ArrayBuffer | string | number | null;
      created_at: number;
    }>(
      `
        SELECT start_offset, end_offset, size_bytes, body, created_at
        FROM ops
        WHERE start_offset >= ? AND end_offset <= ?
        ORDER BY start_offset ASC
      `,
      startOffset,
      endOffset,
    );
    return result.toArray() as ReadChunk[];
  }

  async selectAllOps(_streamId: string): Promise<ReadChunk[]> {
    const result = this.sql.exec<{
      start_offset: number;
      end_offset: number;
      size_bytes: number;
      body: ArrayBuffer | string | number | null;
      created_at: number;
    }>(
      `
        SELECT start_offset, end_offset, size_bytes, body, created_at
        FROM ops
        ORDER BY start_offset ASC
      `,
    );
    return result.toArray() as ReadChunk[];
  }

  async deleteOpsThrough(_streamId: string, endOffset: number): Promise<void> {
    this.sql.exec("DELETE FROM ops WHERE end_offset <= ?", endOffset);
  }

  deleteOpsThroughStatement(_streamId: string, endOffset: number): StorageStatement {
    return { sql: "DELETE FROM ops WHERE end_offset <= ?", args: [endOffset] };
  }

  async getOpsStatsFrom(_streamId: string, startOffset: number): Promise<OpsStats> {
    const result = this.sql.exec<{ messageCount: number; sizeBytes: number }>(
      `
        SELECT COUNT(*) as messageCount,
               COALESCE(SUM(size_bytes), 0) as sizeBytes
        FROM ops
        WHERE start_offset >= ?
      `,
      startOffset,
    );
    const row = result.one();
    return {
      messageCount: row?.messageCount ?? 0,
      sizeBytes: row?.sizeBytes ?? 0,
    };
  }

  async insertSegment(input: SegmentInput): Promise<void> {
    this.sql.exec(
      `
        INSERT INTO segments (
          read_seq,
          r2_key,
          start_offset,
          end_offset,
          content_type,
          created_at,
          expires_at,
          size_bytes,
          message_count
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      input.readSeq,
      input.r2Key,
      input.startOffset,
      input.endOffset,
      input.contentType,
      input.createdAt,
      input.expiresAt,
      input.sizeBytes,
      input.messageCount,
    );
  }

  async getLatestSegment(_streamId: string): Promise<SegmentRecord | null> {
    const result = this.sql.exec<SegmentRecord>(
      "SELECT * FROM segments ORDER BY end_offset DESC, created_at DESC LIMIT 1",
    );
    const rows = result.toArray();
    return rows[0] ?? null;
  }

  async getSegmentByReadSeq(_streamId: string, readSeq: number): Promise<SegmentRecord | null> {
    const result = this.sql.exec<SegmentRecord>(
      "SELECT * FROM segments WHERE read_seq = ? ORDER BY created_at DESC LIMIT 1",
      readSeq,
    );
    const rows = result.toArray();
    return rows[0] ?? null;
  }

  async getSegmentCoveringOffset(_streamId: string, offset: number): Promise<SegmentRecord | null> {
    const result = this.sql.exec<SegmentRecord>(
      `
        SELECT * FROM segments
        WHERE start_offset <= ? AND end_offset > ?
        ORDER BY end_offset DESC LIMIT 1
      `,
      offset,
      offset,
    );
    const rows = result.toArray();
    return rows[0] ?? null;
  }

  async getSegmentStartingAt(_streamId: string, offset: number): Promise<SegmentRecord | null> {
    const result = this.sql.exec<SegmentRecord>(
      "SELECT * FROM segments WHERE start_offset = ? ORDER BY created_at DESC LIMIT 1",
      offset,
    );
    const rows = result.toArray();
    return rows[0] ?? null;
  }

  async listSegments(_streamId: string): Promise<SegmentRecord[]> {
    const result = this.sql.exec<SegmentRecord>(
      "SELECT * FROM segments ORDER BY end_offset ASC, created_at ASC",
    );
    return result.toArray();
  }

  async updateProducerLastUpdated(
    _streamId: string,
    producerId: string,
    lastUpdated: number,
  ): Promise<boolean> {
    const result = this.sql.exec(
      "UPDATE producers SET last_updated = ? WHERE producer_id = ?",
      lastUpdated,
      producerId,
    );
    return result.rowsWritten > 0;
  }

  async listProducers(_streamId: string): Promise<ProducerState[]> {
    const result = this.sql.exec<ProducerState>(
      "SELECT * FROM producers ORDER BY last_updated DESC",
    );
    return result.toArray();
  }
}
