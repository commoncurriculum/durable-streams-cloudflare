/**
 * Storage layer barrel exports
 *
 * Organized by Durable Object:
 * - stream-do: StreamDO storage (streams, producers, ops, segments)
 * - estuary-do: EstuaryDO storage (estuary subscriptions)
 * - stream-subscribers-do: StreamSubscribersDO storage (source stream subscribers)
 *
 * Shared utilities:
 * - registry: KV operations for project/stream metadata
 * - segments: Segment encoding/decoding utilities
 */

// ============================================================================
// StreamDO Storage
// ============================================================================
export { StreamDoStorage } from "./stream-do";
export type {
  StreamStorage,
  StreamMeta,
  ProducerState,
  SegmentRecord,
  ReadChunk,
  OpsStats,
  CreateStreamInput,
  SegmentInput,
  BatchOperation,
  StreamMetaUpdate,
} from "./stream-do";

// ============================================================================
// EstuaryDO Storage
// ============================================================================
export { EstuaryDoStorage } from "./estuary-do";
export type { EstuaryStorage, Subscription, EstuaryInfo } from "./estuary-do";

// ============================================================================
// StreamSubscribersDO Storage
// ============================================================================
export { StreamSubscribersDoStorage } from "./stream-subscribers-do";
export type {
  StreamSubscribersStorage,
  Subscriber,
  SubscriberWithTimestamp,
} from "./stream-subscribers-do";

// ============================================================================
// Shared Utilities
// ============================================================================

// Registry (KV operations)
export {
  createProject,
  addSigningKey,
  removeSigningKey,
  addCorsOrigin,
  removeCorsOrigin,
  updatePrivacy,
  rotateStreamReaderKey,
  putStreamMetadata,
  putProjectEntry,
  getProjectEntry,
  getStreamEntry,
  deleteStreamEntry,
  listProjects,
  listProjectStreams,
} from "./registry";
export type { ProjectEntry, StreamEntry } from "./registry";

// Segments (encoding/decoding utilities)
export { buildSegmentKey, encodeSegmentMessages, readSegmentMessages } from "./segments";

// Read operations (stream-do)
export { readFromOffset, readFromMessages } from "./stream-do";
export { emptyResult, errorResult, gapResult, dataResult } from "./stream-do";
export type { ReadResult } from "./stream-do";
