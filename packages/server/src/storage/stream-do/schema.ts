/**
 * Drizzle ORM schema for StreamDO
 *
 * Tables:
 * - stream_meta: Core stream metadata (content type, offsets, TTL, etc.)
 * - producers: Producer state tracking (epochs, sequences, offsets)
 * - ops: Hot log of recent messages in SQLite
 * - segments: Metadata for cold segments stored in R2
 */

import {
  sqliteTable,
  text,
  integer,
  index,
  blob,
} from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-arktype";

/**
 * stream_meta: One row per stream containing all stream metadata
 */
export const streamMeta = sqliteTable("stream_meta", {
  streamId: text("stream_id").primaryKey(),
  contentType: text("content_type").notNull(),
  closed: integer("closed", { mode: "boolean" }).notNull().default(false),
  tailOffset: integer("tail_offset").notNull().default(0),
  readSeq: integer("read_seq").notNull().default(0),
  segmentStart: integer("segment_start").notNull().default(0),
  segmentMessages: integer("segment_messages").notNull().default(0),
  segmentBytes: integer("segment_bytes").notNull().default(0),
  lastStreamSeq: text("last_stream_seq"),
  ttlSeconds: integer("ttl_seconds"),
  expiresAt: integer("expires_at"),
  createdAt: integer("created_at").notNull(),
  closedAt: integer("closed_at"),
  closedByProducerId: text("closed_by_producer_id"),
  closedByEpoch: integer("closed_by_epoch"),
  closedBySeq: integer("closed_by_seq"),
  public: integer("public", { mode: "boolean" }).notNull().default(false),
});

/**
 * producers: Tracks producer state for idempotent writes
 */
export const producers = sqliteTable("producers", {
  producerId: text("producer_id").primaryKey(),
  epoch: integer("epoch").notNull(),
  lastSeq: integer("last_seq").notNull(),
  lastOffset: integer("last_offset").notNull(),
  lastUpdated: integer("last_updated"),
});

/**
 * ops: Hot log of recent messages (before rotation to R2)
 */
export const ops = sqliteTable(
  "ops",
  {
    startOffset: integer("start_offset").primaryKey(),
    endOffset: integer("end_offset").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    streamSeq: text("stream_seq"),
    producerId: text("producer_id"),
    producerEpoch: integer("producer_epoch"),
    producerSeq: integer("producer_seq"),
    body: blob("body", { mode: "buffer" }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    startOffsetIdx: index("ops_start_offset").on(table.startOffset),
  })
);

/**
 * segments: Metadata for R2-stored cold segments
 */
export const segments = sqliteTable(
  "segments",
  {
    readSeq: integer("read_seq").primaryKey(),
    r2Key: text("r2_key").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    contentType: text("content_type").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
    sizeBytes: integer("size_bytes").notNull(),
    messageCount: integer("message_count").notNull(),
  },
  (table) => ({
    startOffsetIdx: index("segments_start_offset").on(table.startOffset),
  })
);

// ArkType schemas for validation
export const streamMetaSelectSchema = createSelectSchema(streamMeta);
export const streamMetaInsertSchema = createInsertSchema(streamMeta);

export const producerSelectSchema = createSelectSchema(producers);
export const producerInsertSchema = createInsertSchema(producers);

export const opSelectSchema = createSelectSchema(ops);
export const opInsertSchema = createInsertSchema(ops);

export const segmentSelectSchema = createSelectSchema(segments);
export const segmentInsertSchema = createInsertSchema(segments);

// Type exports for use in queries
export type StreamMeta = typeof streamMeta.$inferSelect;
export type StreamMetaInsert = typeof streamMeta.$inferInsert;

export type Producer = typeof producers.$inferSelect;
export type ProducerInsert = typeof producers.$inferInsert;

export type Op = typeof ops.$inferSelect;
export type OpInsert = typeof ops.$inferInsert;

export type Segment = typeof segments.$inferSelect;
export type SegmentInsert = typeof segments.$inferInsert;
