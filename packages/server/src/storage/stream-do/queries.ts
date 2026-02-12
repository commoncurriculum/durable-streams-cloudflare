/**
 * StreamDO storage queries using Drizzle ORM
 *
 * This module provides the StreamStorage implementation using Drizzle ORM
 * for type-safe SQLite operations within the StreamDO Durable Object.
 */

import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, gte, lte, and, lt, sql, desc, asc } from "drizzle-orm";
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
  BatchOperation,
  StreamMetaUpdate,
} from "./types";

/**
 * StreamDO storage implementation using Drizzle ORM
 */
export class StreamDoStorage implements StreamStorage {
  private db: ReturnType<typeof drizzle>;

  constructor(storage: DurableObjectStorage) {
    this.db = drizzle(storage);
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

  async batch(operations: BatchOperation[]): Promise<void> {
    for (const op of operations) {
      await op();
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
    closedBy?: { id: string; epoch: number; seq: number } | null,
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

  updateStreamMetaStatement(_streamId: string, updates: StreamMetaUpdate): BatchOperation {
    return async () => {
      const setObj: Record<string, unknown> = {};

      if (updates.tail_offset !== undefined) {
        setObj.tail_offset = updates.tail_offset;
      }
      if (updates.last_stream_seq !== undefined) {
        setObj.last_stream_seq = updates.last_stream_seq;
      }
      if (updates.read_seq !== undefined) {
        setObj.read_seq = updates.read_seq;
      }
      if (updates.segment_start !== undefined) {
        setObj.segment_start = updates.segment_start;
      }
      if (updates.closed !== undefined) {
        setObj.closed = updates.closed;
      }
      if (updates.closed_at !== undefined) {
        setObj.closed_at = updates.closed_at;
      }
      if ("closed_by_producer_id" in updates) {
        setObj.closed_by_producer_id = updates.closed_by_producer_id;
      }
      if ("closed_by_epoch" in updates) {
        setObj.closed_by_epoch = updates.closed_by_epoch;
      }
      if ("closed_by_seq" in updates) {
        setObj.closed_by_seq = updates.closed_by_seq;
      }

      // Absolute set takes precedence over increment for segment counters
      if (updates.segment_messages !== undefined) {
        setObj.segment_messages = updates.segment_messages;
      } else if (updates.segment_messages_increment !== undefined) {
        setObj.segment_messages = sql`${streamMeta.segment_messages} + ${updates.segment_messages_increment}`;
      }

      if (updates.segment_bytes !== undefined) {
        setObj.segment_bytes = updates.segment_bytes;
      } else if (updates.segment_bytes_increment !== undefined) {
        setObj.segment_bytes = sql`${streamMeta.segment_bytes} + ${updates.segment_bytes_increment}`;
      }

      await this.db.update(streamMeta).set(setObj);
    };
  }

  // ============================================================================
  // Producer Operations
  // ============================================================================

  async getProducer(_streamId: string, producerId: string): Promise<ProducerState | null> {
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
    lastUpdated: number,
  ): BatchOperation {
    return async () => {
      await this.db
        .insert(producers)
        .values({
          producer_id: producer.id,
          epoch: producer.epoch,
          last_seq: producer.seq,
          last_offset: lastOffset,
          last_updated: lastUpdated,
        })
        .onConflictDoUpdate({
          target: producers.producer_id,
          set: {
            epoch: sql`excluded.epoch`,
            last_seq: sql`excluded.last_seq`,
            last_offset: sql`excluded.last_offset`,
            last_updated: sql`excluded.last_updated`,
          },
        });
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
    await this.db.delete(producers).where(eq(producers.producer_id, producerId));
  }

  async updateProducerLastUpdated(
    _streamId: string,
    producerId: string,
    lastUpdated: number,
  ): Promise<boolean> {
    const result = await this.db
      .update(producers)
      .set({ last_updated: lastUpdated })
      .where(eq(producers.producer_id, producerId))
      .returning({ producer_id: producers.producer_id });
    return result.length > 0;
  }

  async listProducers(_streamId: string): Promise<ProducerState[]> {
    return await this.db.select().from(producers).orderBy(desc(producers.last_updated));
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
  }): BatchOperation {
    return async () => {
      await this.db.insert(ops).values({
        start_offset: input.startOffset,
        end_offset: input.endOffset,
        size_bytes: input.sizeBytes,
        stream_seq: input.streamSeq,
        producer_id: input.producerId,
        producer_epoch: input.producerEpoch,
        producer_seq: input.producerSeq,
        body: input.body,
        created_at: input.createdAt,
      });
    };
  }

  async selectOverlap(_streamId: string, offset: number): Promise<ReadChunk | null> {
    const result = await this.db
      .select({
        start_offset: ops.start_offset,
        end_offset: ops.end_offset,
        size_bytes: ops.size_bytes,
        body: ops.body,
        created_at: ops.created_at,
      })
      .from(ops)
      .where(and(lt(ops.start_offset, offset), sql`${ops.end_offset} > ${offset}`))
      .orderBy(desc(ops.start_offset))
      .limit(1);
    return (result[0] as ReadChunk | undefined) ?? null;
  }

  async selectOpsFrom(_streamId: string, offset: number): Promise<ReadChunk[]> {
    const result = await this.db
      .select({
        start_offset: ops.start_offset,
        end_offset: ops.end_offset,
        size_bytes: ops.size_bytes,
        body: ops.body,
        created_at: ops.created_at,
      })
      .from(ops)
      .where(gte(ops.start_offset, offset))
      .orderBy(asc(ops.start_offset))
      .limit(200);
    return result as ReadChunk[];
  }

  async selectOpsRange(
    _streamId: string,
    startOffset: number,
    endOffset: number,
  ): Promise<ReadChunk[]> {
    const result = await this.db
      .select({
        start_offset: ops.start_offset,
        end_offset: ops.end_offset,
        size_bytes: ops.size_bytes,
        body: ops.body,
        created_at: ops.created_at,
      })
      .from(ops)
      .where(and(gte(ops.start_offset, startOffset), lte(ops.end_offset, endOffset)))
      .orderBy(asc(ops.start_offset));
    return result as ReadChunk[];
  }

  async selectAllOps(_streamId: string): Promise<ReadChunk[]> {
    const result = await this.db
      .select({
        start_offset: ops.start_offset,
        end_offset: ops.end_offset,
        size_bytes: ops.size_bytes,
        body: ops.body,
        created_at: ops.created_at,
      })
      .from(ops)
      .orderBy(asc(ops.start_offset));
    return result as ReadChunk[];
  }

  async deleteOpsThrough(_streamId: string, endOffset: number): Promise<void> {
    await this.db.delete(ops).where(lte(ops.end_offset, endOffset));
  }

  deleteOpsThroughStatement(_streamId: string, endOffset: number): BatchOperation {
    return async () => {
      await this.db.delete(ops).where(lte(ops.end_offset, endOffset));
    };
  }

  async getOpsStatsFrom(_streamId: string, startOffset: number): Promise<OpsStats> {
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

  async getSegmentByReadSeq(_streamId: string, readSeq: number): Promise<SegmentRecord | null> {
    const result = await this.db
      .select()
      .from(segments)
      .where(eq(segments.read_seq, readSeq))
      .orderBy(desc(segments.created_at))
      .limit(1);
    return result[0] ?? null;
  }

  async getSegmentCoveringOffset(_streamId: string, offset: number): Promise<SegmentRecord | null> {
    const result = await this.db
      .select()
      .from(segments)
      .where(and(lte(segments.start_offset, offset), sql`${segments.end_offset} > ${offset}`))
      .orderBy(desc(segments.end_offset))
      .limit(1);
    return result[0] ?? null;
  }

  async getSegmentStartingAt(_streamId: string, offset: number): Promise<SegmentRecord | null> {
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
