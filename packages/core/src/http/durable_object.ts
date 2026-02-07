import { DurableObject } from "cloudflare:workers";
import { isExpired } from "../protocol/expiry";
import { SEGMENT_MAX_BYTES_DEFAULT, SEGMENT_MAX_MESSAGES_DEFAULT } from "../protocol/limits";
import { LongPollQueue } from "./handlers/realtime";
import type { SseState } from "./handlers/realtime";
import { DoSqliteStorage } from "../storage/queries";
import type { StreamMeta, ProducerState, SegmentRecord, OpsStats } from "../storage/types";
import { routeRequest } from "./router";
import { Timing, attachTiming } from "../protocol/timing";
import type { StreamContext, StreamEnv } from "./router";
import { ReadPath } from "../stream/read/path";
import { rotateSegment } from "../stream/rotate";
import { encodeStreamOffset, encodeTailOffset, resolveOffsetParam } from "../stream/offsets";

export type StreamIntrospection = {
  meta: StreamMeta;
  ops: OpsStats;
  segments: SegmentRecord[];
  producers: ProducerState[];
  sseClientCount: number;
  longPollWaiterCount: number;
  wsClientCount: number;
};

export class StreamDO extends DurableObject<StreamEnv> {
  private storage: DoSqliteStorage;
  private longPoll = new LongPollQueue();
  private sseState: SseState = { clients: new Map(), nextId: 0 };
  private readPath: ReadPath;
  private rotating = false;

  constructor(ctx: DurableObjectState, env: StreamEnv) {
    super(ctx, env);
    this.storage = new DoSqliteStorage(ctx.storage.sql);
    this.readPath = new ReadPath(env, this.storage);
    ctx.blockConcurrencyWhile(async () => {
      this.storage.initSchema();
    });
  }

  // Handle WebSocket upgrade requests via fetch() — RPC cannot serialize WebSocket responses
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const live = url.searchParams.get("live");
    if (live !== "ws-internal") {
      return new Response("not found", { status: 404 });
    }
    // Extract streamId from the URL path: /v1/stream/:id or /v1/:project/stream/:id
    // The edge worker sends the full URL, so we parse it here.
    // Use a simple approach: the doKey is encoded in the path but we need the
    // streamId that routeStreamRequest would receive. Since the edge worker
    // constructs the WS URL from the original request URL, we can extract it.
    const pathMatch = /\/v1\/([^/]+)\/stream\/(.+)$/.exec(url.pathname);
    const legacyMatch = !pathMatch ? /\/v1\/stream\/(.+)$/.exec(url.pathname) : null;
    let streamId: string;
    let projectId: string;
    try {
      if (pathMatch) {
        projectId = decodeURIComponent(pathMatch[1]);
        streamId = decodeURIComponent(pathMatch[2]);
      } else if (legacyMatch) {
        projectId = "_default";
        streamId = decodeURIComponent(legacyMatch[1]);
      } else {
        return new Response("not found", { status: 404 });
      }
    } catch {
      return new Response("malformed stream id", { status: 400 });
    }
    const doKey = `${projectId}/${streamId}`;
    return this.routeStreamRequest(doKey, false, request);
  }

  // #region docs-do-rpc
  async routeStreamRequest(
    streamId: string,
    timingEnabled: boolean,
    request: Request,
  ): Promise<Response> {
    const timing = timingEnabled ? new Timing() : null;
    const doneTotal = timing?.start("do.total");

    if (this.env.DEBUG_COALESCE === "1" && request.headers.get("X-Debug-Coalesce") === "1") {
      return new Response(JSON.stringify(this.readPath.getStats()), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }

    // #endregion docs-do-rpc

    // #region docs-build-context
    const ctx: StreamContext = {
      state: this.ctx,
      env: this.env,
      storage: this.storage,
      timing,
      longPoll: this.longPoll,
      sseState: this.sseState,
      getStream: this.getStream.bind(this),
      resolveOffset: (streamId, meta, offsetParam) =>
        resolveOffsetParam(this.storage, streamId, meta, offsetParam),
      encodeOffset: (streamId, meta, offset) =>
        encodeStreamOffset(this.storage, streamId, meta, offset),
      encodeTailOffset: (streamId, meta) => encodeTailOffset(this.storage, streamId, meta),
      readFromOffset: (streamId, meta, offset, maxChunkBytes) =>
        this.readPath.readFromOffset(streamId, meta, offset, maxChunkBytes, timing),
      rotateSegment: this.rotateSegment.bind(this),
      getWebSockets: (tag?: string) => this.ctx.getWebSockets(tag),
    };

    const response = await routeRequest(ctx, streamId, request);
    doneTotal?.();
    return attachTiming(response, timing);
    // #endregion docs-build-context
  }

  async getIntrospection(streamId: string): Promise<StreamIntrospection | null> {
    const meta = await this.storage.getStream(streamId);
    if (!meta) return null;

    const ops = await this.storage.getOpsStatsFrom(streamId, 0);
    const segments = await this.storage.listSegments(streamId);
    const producers = await this.storage.listProducers(streamId);

    return {
      meta,
      ops,
      segments,
      producers,
      sseClientCount: this.sseState.clients.size,
      longPollWaiterCount: this.longPoll.getWaiterCount(),
      wsClientCount: this.ctx.getWebSockets().length,
    };
  }

  private async getStream(streamId: string): Promise<StreamMeta | null> {
    const result = await this.storage.getStream(streamId);

    if (!result) return null;
    if (isExpired(result)) {
      await this.deleteStreamData(streamId);
      return null;
    }

    return result;
  }

  private async deleteStreamData(streamId: string): Promise<void> {
    await this.storage.deleteStreamData(streamId);
    // Clean up stream metadata from KV
    if (this.env.REGISTRY) {
      try {
        await this.env.REGISTRY.delete(streamId);
      } catch {
        // Best-effort KV cleanup
      }
    }
  }

  private async rotateSegment(
    streamId: string,
    options?: { force?: boolean; retainOps?: boolean },
  ): Promise<void> {
    if (this.rotating) return;
    this.rotating = true;
    try {
      await rotateSegment({
        env: this.env,
        storage: this.storage,
        streamId,
        segmentMaxMessages: this.segmentMaxMessages(),
        segmentMaxBytes: this.segmentMaxBytes(),
        force: options?.force,
        retainOps: options?.retainOps,
      });
    } finally {
      this.rotating = false;
    }
  }

  private segmentMaxMessages(): number {
    const raw = this.env.SEGMENT_MAX_MESSAGES;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : SEGMENT_MAX_MESSAGES_DEFAULT;
  }

  private segmentMaxBytes(): number {
    const raw = this.env.SEGMENT_MAX_BYTES;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : SEGMENT_MAX_BYTES_DEFAULT;
  }

  // =========================================================================
  // Hibernation API event handlers (internal WebSocket bridge)
  // =========================================================================

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    // Internal bridge: edge worker doesn't send messages to the DO.
    // Reserved for future use (e.g., offset acknowledgements).
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    // Connection closed — no cleanup needed beyond what Cloudflare does
    // automatically. The WebSocket is already removed from getWebSockets().
    if (this.env.METRICS) {
      try {
        const attachment = ws.deserializeAttachment() as { streamId?: string } | null;
        const streamId = attachment?.streamId ?? "unknown";
        this.env.METRICS.writeDataPoint({
          indexes: [streamId],
          blobs: [streamId, "ws_disconnect", "anonymous"],
          doubles: [1, 0],
        });
      } catch { /* best-effort metrics */ }
    }
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    try { ws.close(1011, "internal error"); } catch { /* already closed */ }
  }

  // RPC methods for test tooling (accessible only via service bindings, not HTTP)

  async testForceCompact(streamId: string, retainOps?: boolean): Promise<void> {
    await this.rotateSegment(streamId, { force: true, retainOps: retainOps ?? false });
  }

  async testGetOpsCount(streamId: string): Promise<number> {
    const stats = await this.storage.getOpsStatsFrom(streamId, 0);
    return stats.messageCount;
  }

  async testSetProducerAge(streamId: string, producerId: string, lastUpdated: number): Promise<boolean> {
    return await this.storage.updateProducerLastUpdated(streamId, producerId, lastUpdated);
  }

  async testTruncateLatestSegment(streamId: string): Promise<boolean> {
    if (!this.env.R2) return false;
    const segment = await this.storage.getLatestSegment(streamId);
    if (!segment) return false;
    const object = await this.env.R2.get(segment.r2_key);
    if (!object) return false;
    const buffer = new Uint8Array(await object.arrayBuffer());
    if (buffer.byteLength <= 1) return false;
    const truncated = buffer.slice(0, buffer.byteLength - 1);
    await this.env.R2.put(segment.r2_key, truncated, {
      httpMetadata: { contentType: segment.content_type },
    });
    return true;
  }
}
