import type { StreamMeta, StreamStorage, ReadResult } from "../../../storage/stream-do";
import type { Timing } from "../../shared/timing";
import type { ProducerInput } from "./shared/producer";
import type { LongPollQueue } from "./realtime/handlers";
import type { SseState } from "./realtime/handlers";

// ============================================================================
// Stream Environment & Context (from router)
// ============================================================================

export type StreamEnv = {
  R2?: R2Bucket;
  DEBUG_COALESCE?: string;
  DEBUG_TIMING?: string;
  R2_DELETE_OPS?: string;
  SEGMENT_MAX_MESSAGES?: string;
  SEGMENT_MAX_BYTES?: string;
  MAX_SSE_CLIENTS?: string;
  DO_STORAGE_QUOTA_BYTES?: string;
  METRICS?: AnalyticsEngineDataset;
  REGISTRY?: KVNamespace;
};

export type ResolveOffsetResult = {
  offset: number;
  error?: Response;
};

export type StreamContext = {
  state: DurableObjectState;
  env: StreamEnv;
  storage: StreamStorage;
  timing?: Timing;

  longPoll: LongPollQueue;
  sseState: SseState;
  getStream: (streamId: string) => Promise<StreamMeta | null>;
  resolveOffset: (
    streamId: string,
    meta: StreamMeta,
    offsetParam: string | null,
  ) => Promise<ResolveOffsetResult>;
  encodeOffset: (streamId: string, meta: StreamMeta, offset: number) => Promise<string>;
  encodeTailOffset: (streamId: string, meta: StreamMeta) => Promise<string>;
  readFromOffset: (
    streamId: string,
    meta: StreamMeta,
    offset: number,
    maxChunkBytes: number,
  ) => Promise<ReadResult>;
  rotateSegment: (
    streamId: string,
    options?: { force?: boolean; retainOps?: boolean },
  ) => Promise<void>;
  getWebSockets: (tag?: string) => WebSocket[];
};

// ============================================================================
// Result Types
// ============================================================================

/**
 * Discriminated union for operation results.
 * Used for validation and execution functions that may return an error response.
 */
export type Result<T> = { kind: "ok"; value: T } | { kind: "error"; response: Response };

// ============================================================================
// PUT Operation Types
// ============================================================================

export type RawPutInput = {
  streamId: string;
  contentTypeHeader: string | null;
  closedHeader: string | null;
  ttlHeader: string | null;
  expiresHeader: string | null;
  streamSeqHeader: string | null;
  publicParam: boolean;
  bodyBytes: Uint8Array;
  producer: { value?: ProducerInput; error?: Response } | null;
  requestUrl: string;
};

export type ParsedPutInput = {
  streamId: string;
  contentType: string | null;
  requestedClosed: boolean;
  isPublic: boolean;
  ttlSeconds: number | null;
  effectiveExpiresAt: number | null;
  bodyBytes: Uint8Array;
  streamSeq: string | null;
  producer: ProducerInput | null;
  requestUrl: string;
  now: number;
};

export type ValidatedPutInput =
  | {
      kind: "idempotent";
      existing: StreamMeta;
      streamId: string;
    }
  | {
      kind: "create";
      streamId: string;
      contentType: string;
      requestedClosed: boolean;
      isPublic: boolean;
      ttlSeconds: number | null;
      effectiveExpiresAt: number | null;
      bodyBytes: Uint8Array;
      streamSeq: string | null;
      producer: ProducerInput | null;
      requestUrl: string;
      now: number;
    };

export type PutExecutionResult = {
  status: 200 | 201;
  headers: Headers;
  rotateSegment: boolean;
  forceRotation: boolean;
};

// ============================================================================
// POST Operation Types
// ============================================================================

export type RawPostInput = {
  streamId: string;
  closedHeader: string | null;
  contentTypeHeader: string | null;
  streamSeqHeader: string | null;
  bodyBytes: Uint8Array;
  producer: { value?: ProducerInput; error?: Response } | null;
};

export type ParsedPostInput = {
  streamId: string;
  closeStream: boolean;
  contentType: string | null;
  streamSeq: string | null;
  bodyBytes: Uint8Array;
  producer: ProducerInput | null;
};

export type ValidatedPostInput =
  | {
      kind: "close_only";
      streamId: string;
      meta: StreamMeta;
      producer: ProducerInput | null;
    }
  | {
      kind: "append";
      streamId: string;
      meta: StreamMeta;
      contentType: string;
      bodyBytes: Uint8Array;
      streamSeq: string | null;
      producer: ProducerInput | null;
      closeStream: boolean;
    };

export type PostExecutionResult = {
  status: 200 | 204;
  headers: Headers;
  newTailOffset: number;
  ssePayload: ArrayBuffer | null;
  rotateSegment: boolean;
  forceRotation: boolean;
  messageCount?: number;
  bodyLength?: number;
};

// ============================================================================
// Discriminated Union Variants
// ============================================================================

export type IdempotentPutInput = Extract<ValidatedPutInput, { kind: "idempotent" }>;
export type CreatePutInput = Extract<ValidatedPutInput, { kind: "create" }>;
export type CloseOnlyPostInput = Extract<ValidatedPostInput, { kind: "close_only" }>;
export type AppendPostInput = Extract<ValidatedPostInput, { kind: "append" }>;
