import { errorResponse } from "./protocol/errors";
import { isExpired } from "./protocol/expiry";
import { decodeOffset } from "./protocol/offsets";
import { toUint8Array } from "./protocol/encoding";
import { LongPollQueue } from "./live/long_poll";
import type { SseState } from "./live/types";
import { D1Storage } from "./storage/d1";
import { buildSnapshotKey, encodeSegmentMessages } from "./storage/segments";
import type { StreamMeta } from "./storage/storage";
import { routeRequest } from "./http/router";
import type { StreamContext, StreamEnv, ResolveOffsetResult } from "./http/context";

export type Env = StreamEnv;

export class StreamDO {
  private state: DurableObjectState;
  private env: Env;
  private storage: D1Storage;
  private longPoll = new LongPollQueue();
  private sseState: SseState = { clients: new Map(), nextId: 0 };

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.storage = new D1Storage(env.DB);
  }

  async fetch(request: Request): Promise<Response> {
    const streamId = request.headers.get("X-Stream-Id");
    if (!streamId) {
      return errorResponse(400, "missing stream id");
    }

    const ctx: StreamContext = {
      state: this.state,
      env: this.env,
      storage: this.storage,
      longPoll: this.longPoll,
      sseState: this.sseState,
      getStream: this.getStream.bind(this),
      resolveOffset: this.resolveOffset.bind(this),
      snapshotToR2: this.snapshotToR2.bind(this),
    };

    return routeRequest(ctx, streamId, request);
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
  }

  private resolveOffset(meta: StreamMeta, offsetParam: string | null): ResolveOffsetResult {
    if (offsetParam === null || offsetParam === "-1") {
      return { offset: 0, isNow: false };
    }

    if (offsetParam === "now") {
      return { offset: meta.tail_offset, isNow: true };
    }

    const decoded = decodeOffset(offsetParam);
    if (decoded === null) {
      return { offset: 0, isNow: false, error: errorResponse(400, "invalid offset") };
    }

    if (decoded > meta.tail_offset) {
      return { offset: 0, isNow: false, error: errorResponse(400, "offset beyond tail") };
    }

    return { offset: decoded, isNow: false };
  }

  private async snapshotToR2(
    streamId: string,
    contentType: string,
    endOffset: number,
  ): Promise<void> {
    if (!this.env.R2) return;
    const chunks = await this.storage.selectAllOps(streamId);
    const messages = chunks.map((chunk) => toUint8Array(chunk.body));
    const body = encodeSegmentMessages(messages);

    const key = buildSnapshotKey(streamId, Date.now());
    await this.env.R2.put(key, body, {
      httpMetadata: { contentType },
    });

    await this.storage.insertSnapshot({
      streamId,
      r2Key: key,
      startOffset: 0,
      endOffset,
      contentType,
      createdAt: Date.now(),
    });
  }
}
