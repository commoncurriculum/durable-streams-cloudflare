export type StreamMeta = {
  stream_id: string;
  content_type: string;
  closed: number;
  tail_offset: number;
  last_stream_seq: string | null;
  ttl_seconds: number | null;
  expires_at: number | null;
  created_at: number;
  closed_at: number | null;
  closed_by_producer_id: string | null;
  closed_by_epoch: number | null;
  closed_by_seq: number | null;
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
};

export type CreateStreamInput = {
  streamId: string;
  contentType: string;
  closed: boolean;
  ttlSeconds: number | null;
  expiresAt: number | null;
  createdAt: number;
};

export type SnapshotInput = {
  streamId: string;
  r2Key: string;
  startOffset: number;
  endOffset: number;
  contentType: string;
  createdAt: number;
};

export type SnapshotRecord = {
  stream_id: string;
  r2_key: string;
  start_offset: number;
  end_offset: number;
  content_type: string;
  created_at: number;
};

export interface StreamStorage {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<void>;

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
  ): D1PreparedStatement;
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
  }): D1PreparedStatement;

  updateStreamStatement(
    streamId: string,
    updateFields: string[],
    updateValues: unknown[],
  ): D1PreparedStatement;

  selectOverlap(streamId: string, offset: number): Promise<ReadChunk | null>;
  selectOpsFrom(streamId: string, offset: number): Promise<ReadChunk[]>;
  selectOpsRange(streamId: string, startOffset: number, endOffset: number): Promise<ReadChunk[]>;
  selectAllOps(streamId: string): Promise<ReadChunk[]>;
  deleteOpsThrough(streamId: string, endOffset: number): Promise<void>;

  insertSnapshot(input: SnapshotInput): Promise<void>;
  getLatestSnapshot(streamId: string): Promise<SnapshotRecord | null>;
  getSnapshotCoveringOffset(streamId: string, offset: number): Promise<SnapshotRecord | null>;
  listSnapshots(streamId: string): Promise<SnapshotRecord[]>;

  updateProducerLastUpdated(
    streamId: string,
    producerId: string,
    lastUpdated: number,
  ): Promise<boolean>;
}
