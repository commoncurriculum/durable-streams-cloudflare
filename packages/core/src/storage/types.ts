export type StreamMeta = {
  stream_id: string;
  content_type: string;
  closed: number;
  tail_offset: number;
  read_seq: number;
  segment_start: number;
  segment_messages: number;
  segment_bytes: number;
  last_stream_seq: string | null;
  ttl_seconds: number | null;
  expires_at: number | null;
  created_at: number;
  closed_at: number | null;
  closed_by_producer_id: string | null;
  closed_by_epoch: number | null;
  closed_by_seq: number | null;
  public: number;
};

export type ProducerState = {
  producer_id: string;
  epoch: number;
  last_seq: number;
  last_offset: number;
  last_updated: number | null;
};

export type ReadChunk = {
  start_offset: number;
  end_offset: number;
  size_bytes: number;
  body: ArrayBuffer | Uint8Array | string | number[];
  created_at: number;
};

export type OpsStats = {
  messageCount: number;
  sizeBytes: number;
};

export type CreateStreamInput = {
  streamId: string;
  contentType: string;
  closed: boolean;
  isPublic: boolean;
  ttlSeconds: number | null;
  expiresAt: number | null;
  createdAt: number;
};

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

export type SegmentRecord = {
  stream_id: string;
  r2_key: string;
  start_offset: number;
  end_offset: number;
  read_seq: number;
  content_type: string;
  created_at: number;
  expires_at: number | null;
  size_bytes: number;
  message_count: number;
};

export type StorageStatement = {
  sql: string;
  args: unknown[];
};

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
