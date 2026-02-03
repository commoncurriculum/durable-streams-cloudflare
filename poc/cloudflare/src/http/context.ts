import type { LongPollQueue } from "../live/long_poll";
import type { SseState } from "../live/types";
import type { D1Storage } from "../storage/d1";
import type { ReadResult } from "../engine/stream";
import type { StreamMeta } from "../storage/storage";

export type StreamEnv = {
  DB: D1Database;
  R2?: R2Bucket;
  DEBUG_COALESCE?: string;
  DEBUG_TESTING?: string;
  R2_DELETE_OPS?: string;
};

export type ResolveOffsetResult = {
  offset: number;
  isNow: boolean;
  error?: Response;
};

export type StreamContext = {
  state: DurableObjectState;
  env: StreamEnv;
  storage: D1Storage;
  longPoll: LongPollQueue;
  sseState: SseState;
  getStream: (streamId: string) => Promise<StreamMeta | null>;
  resolveOffset: (meta: StreamMeta, offsetParam: string | null) => ResolveOffsetResult;
  readFromOffset: (
    streamId: string,
    meta: StreamMeta,
    offset: number,
    maxChunkBytes: number,
  ) => Promise<ReadResult>;
  compactToR2: (
    streamId: string,
    options?: { force?: boolean; retainOps?: boolean; flushToTail?: boolean },
  ) => Promise<void>;
};
