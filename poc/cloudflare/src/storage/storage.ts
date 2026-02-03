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

export interface StreamStorage {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<void>;

  getStream(streamId: string): Promise<StreamMeta | null>;
  insertStream(input: CreateStreamInput): Promise<void>;
  closeStream(streamId: string, closedAt: number): Promise<void>;
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
  selectAllOps(streamId: string): Promise<ReadChunk[]>;

  insertSnapshot(input: SnapshotInput): Promise<void>;
}
