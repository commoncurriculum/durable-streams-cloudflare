/**
 * StreamDO storage queries using Drizzle ORM
 *
 * This module provides the StreamStorage implementation using Drizzle ORM
 * for type-safe SQLite operations within the StreamDO Durable Object.
 */

import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, gte, lte, and, sql, desc, asc } from "drizzle-orm";
import { streamMeta, producers, ops, segments } from "./schema";
import type {
  StreamStorage,
  StreamMeta,
  ProducerState,
  ReadChunk,
  OpsStats,
  CreateStreamInput,
  SegmentInput,
  SegmentRecord,
  StorageStatement,
} from "./types";

type SqlStorage = DurableObjectStorage["sql"];

/**
 * StreamDO storage implementation using Drizzle ORM
 */
export class StreamDoStorage implements StreamStorage {
  private db: ReturnType<typeof drizzle>;

  constructor(private sql: SqlStorage) {
    this.db = drizzle(sql);
  }

  /**
   * Initialize database schema
   * Must be called during DO construction within blockConcurrencyWhile
   */
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
        closed_by_seq INTEGER,
        public INTEGER NOT NULL DEFAULT 0
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
  }

  // ============================================================================
  // Batch Operations
  // ============================================================================

  async batch(statements: StorageStatement[]): Promise<void> {
    for (const statement of statements) {
      this.sql.exec(statement.sql, ...statement.args);
    }
  }

  // ============================================================================
  // Stream Meta Operations
  // ============================================================================

  async getStream(_streamId: string): Promise<StreamMeta | null> {
    const result = await this.db.select().from(streamMeta).limit(1);
    return result[0] ?? null;
  }

  async insertStream(input: CreateStreamInput): Promise<void> {
    await this.db.insert(streamMeta).values({
      streamId: input.streamId,
      contentType: input.contentType,
      closed: input.closed,
      tailOffset: 0,
      readSeq: 0,
      segmentStart: 0,
      segmentMessages: 0,
      segmentBytes: 0,
      lastStreamSeq: null,
      ttlSeconds: input.ttlSeconds,
      expiresAt: input.expiresAt,
      createdAt: input.createdAt,
      closedAt: null,
      closedByProducerId: null,
      closedByEpoch: null,
      closedBySeq: null,
      public: input.isPublic,
    });
  }

  async closeStream(
    _streamId: string,
    closedAt: number,
    closedBy?: { id: string; epoch: number; seq: number } | null
  ): Promise<void> {
    if (closedBy) {
      await this.db.update(streamMeta).set({
        closed: true,
        closedAt,
        closedByProducerId: closedBy.id,
        closedByEpoch: closedBy.epoch,
        closedBySeq: closedBy.seq,
      });
      return;
    }

    await this.db.update(streamMeta).set({
      closed: true,
      closedAt,
      closedByProducerId: null,
      closedByEpoch: null,
      closedBySeq: null,
    });
  }

  async deleteStreamData(_streamId: string): Promise<void> {
    await this.db.delete(segments);
    await this.db.delete(ops);
    await this.db.delete(producers);
    await this.db.delete(streamMeta);
  }

  updateStreamStatement(
    _streamId: string,
    updateFields: string[],
    updateValues: unknown[]
  ): StorageStatement {
    return {
      sql: `UPDATE stream_meta SET ${updateFields.join(", ")}`,
      args: updateValues,
    };
  }

  // ============================================================================
  // Producer Operations
  // ============================================================================

  async getProducer(
    _streamId: string,
    producerId: string
  ): Promise<ProducerState | null> {
    const result = await this.db
      .select()
      .from(producers)
      .where(eq(producers.producerId, producerId))
      .limit(1);
    return result[0] ?? null;
  }

  producerUpsertStatement(
    _streamId: string,
    producer: { id: string; epoch: number; seq: number },
    lastOffset: number,
    lastUpdated: number
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
      args: [
        producer.id,
        producer.epoch,
        producer.seq,
        lastOffset,
        lastUpdated,
      ],
    };
  }

  async upsertProducer(
    streamId: string,
    producer: { id: string; epoch: number; seq: number },
    lastOffset: number,
    lastUpdated: number
  ): Promise<void> {
    await this.batch([
      this.producerUpsertStatement(streamId, producer, lastOffset, lastUpdated),
    ]);
  }

  async deleteProducer(_streamId: string, producerId: string): Promise<void> {
    await this.db.delete(producers).where(eq(producers.producerId, producerId));
  }

  async updateProducerLastUpdated(
    _streamId: string,
    producerId: string,
    lastUpdated: number
  ): Promise<boolean> {
    const result = this.sql.exec(
      "UPDATE producers SET last_updated = ? WHERE producer_id = ?",
      lastUpdated,
      producerId
    );
    return result.rowsWritten > 0;
  }

  async listProducers(_streamId: string): Promise<ProducerState[]> {
    return await this.db
      .select()
      .from(producers)
      .orderBy(desc(producers.lastUpdated));
  }

  // ============================================================================
  // Ops Operations
  // ============================================================================

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

  async selectOverlap(
    _streamId: string,
    offset: number
  ): Promise<ReadChunk | null> {
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
      offset
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
      offset
    );
    return result.toArray() as ReadChunk[];
  }

  async selectOpsRange(
    _streamId: string,
    startOffset: number,
    endOffset: number
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
      endOffset
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
      `
    );
    return result.toArray() as ReadChunk[];
  }

  async deleteOpsThrough(_streamId: string, endOffset: number): Promise<void> {
    await this.db.delete(ops).where(lte(ops.endOffset, endOffset));
  }

  deleteOpsThroughStatement(
    _streamId: string,
    endOffset: number
  ): StorageStatement {
    return { sql: "DELETE FROM ops WHERE end_offset <= ?", args: [endOffset] };
  }

  async getOpsStatsFrom(
    _streamId: string,
    startOffset: number
  ): Promise<OpsStats> {
    const result = await this.db
      .select({
        messageCount: sql<number>`COUNT(*)`,
        sizeBytes: sql<number>`COALESCE(SUM(${ops.sizeBytes}), 0)`,
      })
      .from(ops)
      .where(gte(ops.startOffset, startOffset));

    return {
      messageCount: result[0]?.messageCount ?? 0,
      sizeBytes: result[0]?.sizeBytes ?? 0,
    };
  }

  // ============================================================================
  // Segment Operations
  // ============================================================================

  async insertSegment(input: SegmentInput): Promise<void> {
    await this.db.insert(segments).values({
      readSeq: input.readSeq,
      r2Key: input.r2Key,
      startOffset: input.startOffset,
      endOffset: input.endOffset,
      contentType: input.contentType,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      sizeBytes: input.sizeBytes,
      messageCount: input.messageCount,
    });
  }

  async getLatestSegment(_streamId: string): Promise<SegmentRecord | null> {
    const result = await this.db
      .select()
      .from(segments)
      .orderBy(desc(segments.endOffset), desc(segments.createdAt))
      .limit(1);
    return result[0] ?? null;
  }

  async getSegmentByReadSeq(
    _streamId: string,
    readSeq: number
  ): Promise<SegmentRecord | null> {
    const result = await this.db
      .select()
      .from(segments)
      .where(eq(segments.readSeq, readSeq))
      .orderBy(desc(segments.createdAt))
      .limit(1);
    return result[0] ?? null;
  }

  async getSegmentCoveringOffset(
    _streamId: string,
    offset: number
  ): Promise<SegmentRecord | null> {
    const result = await this.db
      .select()
      .from(segments)
      .where(
        and(
          lte(segments.startOffset, offset),
          sql`${segments.endOffset} > ${offset}`
        )
      )
      .orderBy(desc(segments.endOffset))
      .limit(1);
    return result[0] ?? null;
  }

  async getSegmentStartingAt(
    _streamId: string,
    offset: number
  ): Promise<SegmentRecord | null> {
    const result = await this.db
      .select()
      .from(segments)
      .where(eq(segments.startOffset, offset))
      .orderBy(desc(segments.createdAt))
      .limit(1);
    return result[0] ?? null;
  }

  async listSegments(_streamId: string): Promise<SegmentRecord[]> {
    return await this.db
      .select()
      .from(segments)
      .orderBy(asc(segments.endOffset), asc(segments.createdAt));
  }
}
