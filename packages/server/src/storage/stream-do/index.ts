/**
 * StreamDO storage layer
 *
 * Barrel exports for StreamDO Drizzle ORM schema, queries, and types.
 */

export { StreamDoStorage } from "./queries";
export {
  streamMeta,
  producers,
  ops,
  segments,
  streamMetaSelectSchema,
  streamMetaInsertSchema,
  producerSelectSchema,
  producerInsertSchema,
  opSelectSchema,
  opInsertSchema,
  segmentSelectSchema,
  segmentInsertSchema,
} from "./schema";
export type {
  StreamMeta,
  StreamMetaInsert,
  Producer,
  ProducerInsert,
  Op,
  OpInsert,
  Segment,
  SegmentInsert,
} from "./schema";
export type {
  StreamStorage,
  ProducerState,
  SegmentRecord,
  ReadChunk,
  OpsStats,
  CreateStreamInput,
  SegmentInput,
  BatchOperation,
  StreamMetaUpdate,
} from "./types";

// Read operations
export { readFromOffset } from "./read";
export { readFromMessages } from "./read-messages";
export { emptyResult, errorResult, gapResult, dataResult } from "./read-result";
export type { ReadResult } from "./read-result";
