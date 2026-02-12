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
  body: ArrayBuffer | Uint8Array | string | number[];
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
 * Storage statement for batch operations
 */
export type StorageStatement = {
  sql: string;
  args: unknown[];
};

/**
 * Interface for StreamDO storage operations
 */
export interface StreamStorage {
  batch(statements: StorageStatement[]): Promise<void>;

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
  ): StorageStatement;
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
  }): StorageStatement;

  updateStreamStatement(
    streamId: string,
    updateFields: string[],
    updateValues: unknown[],
  ): StorageStatement;

  selectOverlap(streamId: string, offset: number): Promise<ReadChunk | null>;
  selectOpsFrom(streamId: string, offset: number): Promise<ReadChunk[]>;
  selectOpsRange(streamId: string, startOffset: number, endOffset: number): Promise<ReadChunk[]>;
  selectAllOps(streamId: string): Promise<ReadChunk[]>;
  deleteOpsThrough(streamId: string, endOffset: number): Promise<void>;
  deleteOpsThroughStatement(streamId: string, endOffset: number): StorageStatement;
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
