import type { StreamMeta } from "../storage/storage";
import type { ProducerInput } from "../engine/producer";

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

/**
 * Raw data extracted from a PUT request before parsing.
 */
export type RawPutInput = {
  streamId: string;
  contentTypeHeader: string | null;
  closedHeader: string | null;
  ttlHeader: string | null;
  expiresHeader: string | null;
  streamSeqHeader: string | null;
  bodyBytes: Uint8Array;
  producer: { value?: ProducerInput; error?: Response } | null;
  requestUrl: string;
};

/**
 * Parsed and normalized PUT input ready for validation.
 */
export type ParsedPutInput = {
  streamId: string;
  contentType: string | null;
  requestedClosed: boolean;
  ttlSeconds: number | null;
  effectiveExpiresAt: number | null;
  bodyBytes: Uint8Array;
  streamSeq: string | null;
  producer: ProducerInput | null;
  requestUrl: string;
  now: number;
};

/**
 * Validated PUT input - discriminated by operation type.
 */
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
      ttlSeconds: number | null;
      effectiveExpiresAt: number | null;
      bodyBytes: Uint8Array;
      streamSeq: string | null;
      producer: ProducerInput | null;
      requestUrl: string;
      now: number;
    };

/**
 * Result of PUT execution.
 */
export type PutExecutionResult = {
  status: 200 | 201;
  headers: Headers;
  rotateSegment: boolean;
  forceRotation: boolean;
};

// ============================================================================
// POST Operation Types
// ============================================================================

/**
 * Raw data extracted from a POST request before parsing.
 */
export type RawPostInput = {
  streamId: string;
  closedHeader: string | null;
  contentTypeHeader: string | null;
  streamSeqHeader: string | null;
  bodyBytes: Uint8Array;
  producer: { value?: ProducerInput; error?: Response } | null;
};

/**
 * Parsed and normalized POST input ready for validation.
 */
export type ParsedPostInput = {
  streamId: string;
  closeStream: boolean;
  contentType: string | null;
  streamSeq: string | null;
  bodyBytes: Uint8Array;
  producer: ProducerInput | null;
};

/**
 * Validated POST input - discriminated by operation type.
 */
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

/**
 * Result of POST execution.
 */
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

// PUT operation variants
export type IdempotentPutInput = Extract<ValidatedPutInput, { kind: "idempotent" }>;
export type CreatePutInput = Extract<ValidatedPutInput, { kind: "create" }>;

// POST operation variants
export type CloseOnlyPostInput = Extract<ValidatedPostInput, { kind: "close_only" }>;
export type AppendPostInput = Extract<ValidatedPostInput, { kind: "append" }>;
