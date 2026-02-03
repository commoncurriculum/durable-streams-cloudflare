import type {
  CreateStreamInput,
  ProducerState,
  ReadChunk,
  SnapshotInput,
  StreamMeta,
  StreamStorage,
} from "./storage";

export class D1Storage implements StreamStorage {
  constructor(private db: D1Database) {}

  prepare(sql: string): D1PreparedStatement {
    return this.db.prepare(sql);
  }

  async batch(statements: D1PreparedStatement[]): Promise<void> {
    await this.db.batch(statements);
  }

  async getStream(streamId: string): Promise<StreamMeta | null> {
    const result = await this.db
      .prepare("SELECT * FROM streams WHERE stream_id = ?")
      .bind(streamId)
      .first<StreamMeta>();
    return result ?? null;
  }

  async insertStream(input: CreateStreamInput): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO streams (stream_id, content_type, closed, tail_offset, last_stream_seq, ttl_seconds, expires_at, created_at) VALUES (?, ?, ?, 0, NULL, ?, ?, ?)",
      )
      .bind(
        input.streamId,
        input.contentType,
        input.closed ? 1 : 0,
        input.ttlSeconds,
        input.expiresAt,
        input.createdAt,
      )
      .run();
  }

  async closeStream(streamId: string, closedAt: number): Promise<void> {
    await this.db
      .prepare("UPDATE streams SET closed = 1, closed_at = ? WHERE stream_id = ?")
      .bind(closedAt, streamId)
      .run();
  }

  async deleteStreamData(streamId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM snapshots WHERE stream_id = ?").bind(streamId),
      this.db.prepare("DELETE FROM ops WHERE stream_id = ?").bind(streamId),
      this.db.prepare("DELETE FROM producers WHERE stream_id = ?").bind(streamId),
      this.db.prepare("DELETE FROM streams WHERE stream_id = ?").bind(streamId),
    ]);
  }

  async getProducer(streamId: string, producerId: string): Promise<ProducerState | null> {
    const result = await this.db
      .prepare("SELECT * FROM producers WHERE stream_id = ? AND producer_id = ?")
      .bind(streamId, producerId)
      .first<ProducerState>();
    return result ?? null;
  }

  producerUpsertStatement(
    streamId: string,
    producer: { id: string; epoch: number; seq: number },
    lastOffset: number,
    lastUpdated: number,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        "INSERT INTO producers (stream_id, producer_id, epoch, last_seq, last_offset, last_updated) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(stream_id, producer_id) DO UPDATE SET epoch = excluded.epoch, last_seq = excluded.last_seq, last_offset = excluded.last_offset, last_updated = excluded.last_updated",
      )
      .bind(streamId, producer.id, producer.epoch, producer.seq, lastOffset, lastUpdated);
  }

  async upsertProducer(
    streamId: string,
    producer: { id: string; epoch: number; seq: number },
    lastOffset: number,
    lastUpdated: number,
  ): Promise<void> {
    await this.producerUpsertStatement(streamId, producer, lastOffset, lastUpdated).run();
  }

  async deleteProducer(streamId: string, producerId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM producers WHERE stream_id = ? AND producer_id = ?")
      .bind(streamId, producerId)
      .run();
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
  }): D1PreparedStatement {
    return this.db
      .prepare(
        "INSERT INTO ops (stream_id, start_offset, end_offset, size_bytes, stream_seq, producer_id, producer_epoch, producer_seq, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        input.streamId,
        input.startOffset,
        input.endOffset,
        input.sizeBytes,
        input.streamSeq,
        input.producerId,
        input.producerEpoch,
        input.producerSeq,
        input.body,
        input.createdAt,
      );
  }

  updateStreamStatement(
    streamId: string,
    updateFields: string[],
    updateValues: unknown[],
  ): D1PreparedStatement {
    return this.db
      .prepare(`UPDATE streams SET ${updateFields.join(", ")} WHERE stream_id = ?`)
      .bind(...updateValues, streamId);
  }

  async selectOverlap(streamId: string, offset: number): Promise<ReadChunk | null> {
    const result = await this.db
      .prepare(
        "SELECT start_offset, end_offset, size_bytes, body FROM ops WHERE stream_id = ? AND start_offset < ? AND end_offset > ? ORDER BY start_offset DESC LIMIT 1",
      )
      .bind(streamId, offset, offset)
      .first<ReadChunk>();
    return result ?? null;
  }

  async selectOpsFrom(streamId: string, offset: number): Promise<ReadChunk[]> {
    const result = await this.db
      .prepare(
        "SELECT start_offset, end_offset, size_bytes, body FROM ops WHERE stream_id = ? AND start_offset >= ? ORDER BY start_offset ASC LIMIT 200",
      )
      .bind(streamId, offset)
      .all<ReadChunk>();
    return result.results ?? [];
  }

  async selectAllOps(streamId: string): Promise<ReadChunk[]> {
    const result = await this.db
      .prepare(
        "SELECT start_offset, end_offset, size_bytes, body FROM ops WHERE stream_id = ? ORDER BY start_offset ASC",
      )
      .bind(streamId)
      .all<ReadChunk>();
    return result.results ?? [];
  }

  async insertSnapshot(input: SnapshotInput): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO snapshots (stream_id, r2_key, start_offset, end_offset, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        input.streamId,
        input.r2Key,
        input.startOffset,
        input.endOffset,
        input.contentType,
        input.createdAt,
      )
      .run();
  }
}
