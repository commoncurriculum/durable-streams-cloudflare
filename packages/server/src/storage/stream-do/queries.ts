/**
 * StreamDO storage queries using Drizzle ORM
 *
 * This module provides the StreamStorage implementation using Drizzle ORM
 * for type-safe SQLite operations within the StreamDO Durable Object.
 */

import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, gte, lte, and, sql, desc, asc } from "drizzle-orm";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../../drizzle/migrations";
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

/**
 * StreamDO storage implementation using Drizzle ORM
 */
export class StreamDoStorage implements StreamStorage {
  private db: ReturnType<typeof drizzle>;
  private sql: DurableObjectStorage["sql"];

  constructor(storage: DurableObjectStorage) {
    this.db = drizzle(storage);
    this.sql = storage.sql;
  }

  /**
   * Initialize database schema using Drizzle migrations
   * Must be called during DO construction within blockConcurrencyWhile
   */
  initSchema(): void {
    migrate(this.db, migrations);
  }

  // ============================================================================
  // Batch Operations
  // ============================================================================

  async batch(statements: StorageStatement[]): Promise<void> {
    // Execute raw SQL statements synchronously
    // Durable Objects SQLite doesn't have async batch API
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
      stream_id: input.streamId,
      content_type: input.contentType,
      closed: input.closed ? 1 : 0,
      tail_offset: 0,
      read_seq: 0,
      segment_start: 0,
      segment_messages: 0,
      segment_bytes: 0,
      last_stream_seq: null,
      ttl_seconds: input.ttlSeconds,
      expires_at: input.expiresAt,
      created_at: input.createdAt,
      closed_at: null,
      closed_by_producer_id: null,
      closed_by_epoch: null,
      closed_by_seq: null,
      public: input.isPublic ? 1 : 0,
    });
  }

  async closeStream(
    _streamId: string,
    closedAt: number,
    closedBy?: { id: string; epoch: number; seq: number } | null
  ): Promise<void> {
    if (closedBy) {
      await this.db.update(streamMeta).set({
        closed: 1,
        closed_at: closedAt,
        closed_by_producer_id: closedBy.id,
        closed_by_epoch: closedBy.epoch,
        closed_by_seq: closedBy.seq,
      });
      return;
    }

    await this.db.update(streamMeta).set({
      closed: 1,
      closed_at: closedAt,
      closed_by_producer_id: null,
      closed_by_epoch: null,
      closed_by_seq: null,
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
    // StorageStatement for batch() - raw SQL preserved for dynamic field updates
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
      .where(eq(producers.producer_id, producerId))
      .limit(1);
    return result[0] ?? null;
  }

  producerUpsertStatement(
    _streamId: string,
    producer: { id: string; epoch: number; seq: number },
    lastOffset: number,
    lastUpdated: number
  ): StorageStatement {
    // StorageStatement for batch() - could use Drizzle but raw SQL works
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
    await this.db
      .delete(producers)
      .where(eq(producers.producer_id, producerId));
  }

  async updateProducerLastUpdated(
    _streamId: string,
    producerId: string,
    lastUpdated: number
  ): Promise<boolean> {
    this.sql.exec(
      "UPDATE producers SET last_updated = ? WHERE producer_id = ?",
      lastUpdated,
      producerId
    );
    const changes = this.sql.exec("SELECT changes() as c").one();
    return (changes.c as number) > 0;
  }

  async listProducers(_streamId: string): Promise<ProducerState[]> {
    return await this.db
      .select()
      .from(producers)
      .orderBy(desc(producers.last_updated));
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
    // StorageStatement for batch() - raw SQL preserved for performance
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
    // Use raw SQL to avoid Drizzle's blob { mode: "buffer" } which
    // calls Node.js Buffer (unavailable in Workers runtime).
    const cursor = this.sql.exec(
      "SELECT start_offset, end_offset, size_bytes, body, created_at FROM ops WHERE start_offset < ? AND end_offset > ? ORDER BY start_offset DESC LIMIT 1",
      offset,
      offset
    );
    const rows = [...cursor];
    if (rows.length === 0) return null;
    return rows[0] as unknown as ReadChunk;
  }

  async selectOpsFrom(_streamId: string, offset: number): Promise<ReadChunk[]> {
    // Use raw SQL to avoid Drizzle's blob { mode: "buffer" } which
    // calls Node.js Buffer (unavailable in Workers runtime).
    const cursor = this.sql.exec(
      "SELECT start_offset, end_offset, size_bytes, body, created_at FROM ops WHERE start_offset >= ? ORDER BY start_offset ASC LIMIT 200",
      offset
    );
    return [...cursor] as unknown as ReadChunk[];
  }

  async selectOpsRange(
    _streamId: string,
    startOffset: number,
    endOffset: number
  ): Promise<ReadChunk[]> {
    // Use raw SQL to avoid Drizzle's blob { mode: "buffer" } which
    // calls Node.js Buffer (unavailable in Workers runtime).
    const cursor = this.sql.exec(
      "SELECT start_offset, end_offset, size_bytes, body, created_at FROM ops WHERE start_offset >= ? AND end_offset <= ? ORDER BY start_offset ASC",
      startOffset,
      endOffset
    );
    return [...cursor] as unknown as ReadChunk[];
  }

  async selectAllOps(_streamId: string): Promise<ReadChunk[]> {
    // Use raw SQL to avoid Drizzle's blob { mode: "buffer" } which
    // calls Node.js Buffer (unavailable in Workers runtime).
    const cursor = this.sql.exec(
      "SELECT start_offset, end_offset, size_bytes, body, created_at FROM ops ORDER BY start_offset ASC"
    );
    return [...cursor] as unknown as ReadChunk[];
  }

  async deleteOpsThrough(_streamId: string, endOffset: number): Promise<void> {
    await this.db.delete(ops).where(lte(ops.end_offset, endOffset));
  }

  deleteOpsThroughStatement(
    _streamId: string,
    endOffset: number
  ): StorageStatement {
    // StorageStatement for batch()
    return { sql: "DELETE FROM ops WHERE end_offset <= ?", args: [endOffset] };
  }

  async getOpsStatsFrom(
    _streamId: string,
    startOffset: number
  ): Promise<OpsStats> {
    const result = await this.db
      .select({
        messageCount: sql<number>`COUNT(*)`,
        sizeBytes: sql<number>`COALESCE(SUM(${ops.size_bytes}), 0)`,
      })
      .from(ops)
      .where(gte(ops.start_offset, startOffset));

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
      read_seq: input.readSeq,
      r2_key: input.r2Key,
      start_offset: input.startOffset,
      end_offset: input.endOffset,
      content_type: input.contentType,
      created_at: input.createdAt,
      expires_at: input.expiresAt,
      size_bytes: input.sizeBytes,
      message_count: input.messageCount,
    });
  }

  async getLatestSegment(_streamId: string): Promise<SegmentRecord | null> {
    const result = await this.db
      .select()
      .from(segments)
      .orderBy(desc(segments.end_offset), desc(segments.created_at))
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
      .where(eq(segments.read_seq, readSeq))
      .orderBy(desc(segments.created_at))
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
          lte(segments.start_offset, offset),
          sql`${segments.end_offset} > ${offset}`
        )
      )
      .orderBy(desc(segments.end_offset))
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
      .where(eq(segments.start_offset, offset))
      .orderBy(desc(segments.created_at))
      .limit(1);
    return result[0] ?? null;
  }

  async listSegments(_streamId: string): Promise<SegmentRecord[]> {
    return await this.db
      .select()
      .from(segments)
      .orderBy(asc(segments.end_offset), asc(segments.created_at));
  }
}
