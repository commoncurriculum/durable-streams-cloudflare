/**
 * Types for StreamDO storage operations
 *
 * These types define the interfaces and data structures used by the StreamDO
 * storage layer, complementing the Drizzle schema definitions.
 */

import type { StreamMeta, Producer, Op, Segment } from "./schema";

/**
 * Re-export Drizzle-inferred types for external use
 */
export type { StreamMeta, Producer, Op, Segment };

/**
 * Legacy type alias for compatibility
 */
export type ProducerState = Producer;

/**
 * Legacy type alias for compatibility
 */
export type SegmentRecord = Segment;

/**
 * Read chunk returned from ops queries
 */
export type ReadChunk = {
  start_offset: number;
  end_offset: number;
  size_bytes: number;
  body: ArrayBuffer;
  created_at: number;
};

/**
 * Statistics for ops in a range
 */
export type OpsStats = {
  messageCount: number;
  sizeBytes: number;
};

/**
 * Input for creating a new stream
 */
export type CreateStreamInput = {
  streamId: string;
  contentType: string;
  closed: boolean;
  isPublic: boolean;
  ttlSeconds: number | null;
  expiresAt: number | null;
  createdAt: number;
};

/**
 * Input for inserting a segment record
 */
export type SegmentInput = {
  streamId: string;
  r2Key: string;
  startOffset: number;
  endOffset: number;
  readSeq: number;
  contentType: string;
  createdAt: number;
  expiresAt: number | null;
  sizeBytes: number;
  messageCount: number;
};

/**
 * A deferred storage operation for use in batch().
 *
 * Each BatchOperation is a thunk that, when called, executes a single
 * Drizzle ORM statement. Operations are collected and then executed
 * sequentially inside batch() to form an atomic unit of work within
 * a single Durable Object blockConcurrencyWhile callback.
 */
export type BatchOperation = () => Promise<void>;

/**
 * Typed update descriptor for stream_meta fields.
 *
 * For segment counters, use the `_increment` variants for relative
 * additions (append path) and the bare field names for absolute
 * sets (rotate path). If both are provided for the same counter,
 * the absolute value takes precedence.
 */
export type StreamMetaUpdate = {
  tail_offset?: number;
  last_stream_seq?: string;
  read_seq?: number;
  segment_start?: number;
  /** Absolute set for segment_messages */
  segment_messages?: number;
  /** Absolute set for segment_bytes */
  segment_bytes?: number;
  /** Increment segment_messages by this amount */
  segment_messages_increment?: number;
  /** Increment segment_bytes by this amount */
  segment_bytes_increment?: number;
  closed?: number;
  closed_at?: number;
  closed_by_producer_id?: string | null;
  closed_by_epoch?: number | null;
  closed_by_seq?: number | null;
};

/**
 * Interface for StreamDO storage operations
 */
export interface StreamStorage {
  batch(operations: BatchOperation[]): Promise<void>;

  getStream(streamId: string): Promise<StreamMeta | null>;
  insertStream(input: CreateStreamInput): Promise<void>;
  closeStream(
    streamId: string,
    closedAt: number,
    closedBy?: { id: string; epoch: number; seq: number } | null,
  ): Promise<void>;
  deleteStreamData(streamId: string): Promise<void>;

  getProducer(streamId: string, producerId: string): Promise<ProducerState | null>;
  producerUpsertStatement(
    streamId: string,
    producer: { id: string; epoch: number; seq: number },
    lastOffset: number,
    lastUpdated: number,
  ): BatchOperation;
  upsertProducer(
    streamId: string,
    producer: { id: string; epoch: number; seq: number },
    lastOffset: number,
    lastUpdated: number,
  ): Promise<void>;
  deleteProducer(streamId: string, producerId: string): Promise<void>;

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
  }): BatchOperation;

  updateStreamMetaStatement(streamId: string, updates: StreamMetaUpdate): BatchOperation;

  selectOverlap(streamId: string, offset: number): Promise<ReadChunk | null>;
  selectOpsFrom(streamId: string, offset: number): Promise<ReadChunk[]>;
  selectOpsRange(streamId: string, startOffset: number, endOffset: number): Promise<ReadChunk[]>;
  selectAllOps(streamId: string): Promise<ReadChunk[]>;
  deleteOpsThrough(streamId: string, endOffset: number): Promise<void>;
  deleteOpsThroughStatement(streamId: string, endOffset: number): BatchOperation;
  getOpsStatsFrom(streamId: string, startOffset: number): Promise<OpsStats>;

  insertSegment(input: SegmentInput): Promise<void>;
  getLatestSegment(streamId: string): Promise<SegmentRecord | null>;
  getSegmentByReadSeq(streamId: string, readSeq: number): Promise<SegmentRecord | null>;
  getSegmentCoveringOffset(streamId: string, offset: number): Promise<SegmentRecord | null>;
  getSegmentStartingAt(streamId: string, offset: number): Promise<SegmentRecord | null>;
  listSegments(streamId: string): Promise<SegmentRecord[]>;

  updateProducerLastUpdated(
    streamId: string,
    producerId: string,
    lastUpdated: number,
  ): Promise<boolean>;

  listProducers(streamId: string): Promise<ProducerState[]>;
}
