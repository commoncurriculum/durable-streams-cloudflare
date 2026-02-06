import { errorResponse } from "../protocol/errors";
import type { LongPollQueue } from "./handlers/realtime";
import type { SseState } from "./handlers/realtime";
import type { ReadResult } from "../stream/read/result";
import type { StreamMeta, StreamStorage } from "../storage/types";
import type { Timing } from "../protocol/timing";
import { createDoApp } from "./hono";
import { handleDelete, handlePost, handlePut } from "./handlers/write";
import { handleGet, handleHead } from "./handlers/read";

// ============================================================================
// StreamEnv + StreamContext
// ============================================================================

export type StreamEnv = {
  STREAMS?: DurableObjectNamespace;
  R2?: R2Bucket;
  ADMIN_DB?: D1Database;
  DEBUG_COALESCE?: string;
  DEBUG_TESTING?: string;
  DEBUG_TIMING?: string;
  R2_DELETE_OPS?: string;
  SEGMENT_MAX_MESSAGES?: string;
  SEGMENT_MAX_BYTES?: string;
  METRICS?: AnalyticsEngineDataset;
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
// Cache Mode
// ============================================================================

export type CacheMode = "shared" | "private";

export const CACHE_MODE_HEADER = "X-Cache-Mode";

export function normalizeCacheMode(value: string | null | undefined): CacheMode | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower === "shared" || lower === "private") return lower;
  return null;
}

export function resolveCacheMode(params: {
  envMode?: string | null;
  authMode?: CacheMode;
}): CacheMode {
  const envMode = normalizeCacheMode(params.envMode ?? null);
  if (envMode) return envMode;
  if (params.authMode) return params.authMode;
  return "private";
}

export function getCacheMode(request: Request): CacheMode {
  return normalizeCacheMode(request.headers.get(CACHE_MODE_HEADER)) ?? "private";
}

// ============================================================================
// Read Auth
// ============================================================================

export const SESSION_ID_HEADER = "X-Session-Id";

// ============================================================================
// Router
// ============================================================================

export async function routeRequest(
  ctx: StreamContext,
  streamId: string,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  try {
    if (url.pathname.startsWith("/internal/")) {
      const doApp = createDoApp(ctx, streamId);
      return await doApp.fetch(request);
    }

    if (method === "PUT") return await handlePut(ctx, streamId, request);
    if (method === "POST") return await handlePost(ctx, streamId, request);
    if (method === "GET") return await handleGet(ctx, streamId, request, url);
    if (method === "HEAD") return await handleHead(ctx, streamId, request);
    if (method === "DELETE") return await handleDelete(ctx, streamId);
    return errorResponse(405, "method not allowed");
  } catch (e) {
    return errorResponse(500, e instanceof Error ? e.message : "internal error");
  }
}
