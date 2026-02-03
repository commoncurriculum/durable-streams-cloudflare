import type { LongPollQueue } from "../live/long_poll";
import type { SseState } from "../live/types";
import type { ReadResult } from "../engine/stream";
import type { StreamMeta, StreamStorage } from "../storage/storage";

export type StreamEnv = {
  R2?: R2Bucket;
  ADMIN_DB?: D1Database;
  DEBUG_COALESCE?: string;
  DEBUG_TESTING?: string;
  R2_DELETE_OPS?: string;
  SEGMENT_MAX_MESSAGES?: string;
  SEGMENT_MAX_BYTES?: string;
};

export type ResolveOffsetResult = {
  offset: number;
  error?: Response;
};

export type StreamContext = {
  state: DurableObjectState;
  env: StreamEnv;
  storage: StreamStorage;
  longPoll: LongPollQueue;
  sseState: SseState;
  getStream: (streamId: string) => Promise<StreamMeta | null>;
  resolveOffset: (
    streamId: string,
    meta: StreamMeta,
    offsetParam: string | null,
  ) => Promise<ResolveOffsetResult>;
  encodeOffset: (streamId: string, meta: StreamMeta, offset: number) => Promise<string>;
  encodeTailOffset: (meta: StreamMeta) => string;
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
};
