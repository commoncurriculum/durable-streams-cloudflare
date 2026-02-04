import type { LongPollQueue } from "../live/long_poll";
import type { SseState } from "../live/types";
import type { ReadResult } from "../engine/stream";
import type { StreamMeta, StreamStorage } from "../storage/storage";
import type { Timing } from "../protocol/timing";

export type StreamEnv = {
  STREAMS?: DurableObjectNamespace;
  FANOUT_QUEUE?: Queue;
  SESSION_TTL_SECONDS?: string;
  R2?: R2Bucket;
  ADMIN_DB?: D1Database;
  DEBUG_COALESCE?: string;
  DEBUG_TESTING?: string;
  DEBUG_TIMING?: string;
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
  timing?: Timing | null;
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
};
