import { errorResponse } from "../protocol/errors";
import type { LongPollQueue } from "./handlers/realtime";
import type { SseState } from "./handlers/realtime";
import type { ReadResult } from "../stream/read/result";
import type { StreamMeta, StreamStorage } from "../storage/types";
import type { Timing } from "../protocol/timing";
import { handleDelete, handlePost, handlePut } from "./handlers/write";
import { handleGet, handleHead } from "./handlers/read";

// ============================================================================
// StreamEnv + StreamContext
// ============================================================================

export type StreamEnv = {
  R2?: R2Bucket;
  DEBUG_COALESCE?: string;
  DEBUG_TIMING?: string;
  R2_DELETE_OPS?: string;
  SEGMENT_MAX_MESSAGES?: string;
  SEGMENT_MAX_BYTES?: string;
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

// ============================================================================
// Router
// ============================================================================

// #region docs-route-request
export async function routeRequest(
  ctx: StreamContext,
  streamId: string,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  try {
    if (method === "PUT") return await handlePut(ctx, streamId, request);
    if (method === "POST") return await handlePost(ctx, streamId, request);
    if (method === "GET") return await handleGet(ctx, streamId, request, url);
    if (method === "HEAD") return await handleHead(ctx, streamId);
    if (method === "DELETE") return await handleDelete(ctx, streamId);
    return errorResponse(405, "method not allowed");
  } catch (e) {
    return errorResponse(500, e instanceof Error ? e.message : "internal error");
  }
}
// #endregion docs-route-request
