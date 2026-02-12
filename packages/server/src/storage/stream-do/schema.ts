/**
 * Drizzle ORM schema for StreamDO
 *
 * Tables:
 * - stream_meta: Core stream metadata (content type, offsets, TTL, etc.)
 * - producers: Producer state tracking (epochs, sequences, offsets)
 * - ops: Hot log of recent messages in SQLite
 * - segments: Metadata for cold segments stored in R2
 */

import { sqliteTable, text, integer, index, blob } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-arktype";

/**
 * stream_meta: One row per stream containing all stream metadata
 */
export const streamMeta = sqliteTable("stream_meta", {
  stream_id: text("stream_id").primaryKey(),
  content_type: text("content_type").notNull(),
  closed: integer("closed").notNull().default(0),
  tail_offset: integer("tail_offset").notNull().default(0),
  read_seq: integer("read_seq").notNull().default(0),
  segment_start: integer("segment_start").notNull().default(0),
  segment_messages: integer("segment_messages").notNull().default(0),
  segment_bytes: integer("segment_bytes").notNull().default(0),
  last_stream_seq: text("last_stream_seq"),
  ttl_seconds: integer("ttl_seconds"),
  expires_at: integer("expires_at"),
  created_at: integer("created_at").notNull(),
  closed_at: integer("closed_at"),
  closed_by_producer_id: text("closed_by_producer_id"),
  closed_by_epoch: integer("closed_by_epoch"),
  closed_by_seq: integer("closed_by_seq"),
  public: integer("public").notNull().default(0),
});

/**
 * producers: Tracks producer state for idempotent writes
 */
export const producers = sqliteTable("producers", {
  producer_id: text("producer_id").primaryKey(),
  epoch: integer("epoch").notNull(),
  last_seq: integer("last_seq").notNull(),
  last_offset: integer("last_offset").notNull(),
  last_updated: integer("last_updated"),
});

/**
 * ops: Hot log of recent messages (before rotation to R2)
 */
export const ops = sqliteTable(
  "ops",
  {
    start_offset: integer("start_offset").primaryKey(),
    end_offset: integer("end_offset").notNull(),
    size_bytes: integer("size_bytes").notNull(),
    stream_seq: text("stream_seq"),
    producer_id: text("producer_id"),
    producer_epoch: integer("producer_epoch"),
    producer_seq: integer("producer_seq"),
    body: blob("body", { mode: "buffer" }).notNull(),
    created_at: integer("created_at").notNull(),
  },
  (table) => ({
    startOffsetIdx: index("ops_start_offset").on(table.start_offset),
  }),
);

/**
 * segments: Metadata for R2-stored cold segments
 */
export const segments = sqliteTable(
  "segments",
  {
    read_seq: integer("read_seq").primaryKey(),
    r2_key: text("r2_key").notNull(),
    start_offset: integer("start_offset").notNull(),
    end_offset: integer("end_offset").notNull(),
    content_type: text("content_type").notNull(),
    created_at: integer("created_at").notNull(),
    expires_at: integer("expires_at"),
    size_bytes: integer("size_bytes").notNull(),
    message_count: integer("message_count").notNull(),
  },
  (table) => ({
    startOffsetIdx: index("segments_start_offset").on(table.start_offset),
  }),
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
