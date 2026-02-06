import {
  HEADER_SSE_DATA_ENCODING,
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_NEXT_OFFSET,
  HEADER_STREAM_UP_TO_DATE,
  HEADER_STREAM_CURSOR,
  baseHeaders,
  isTextual,
} from "../../protocol/headers";
import { errorResponse } from "../../protocol/errors";
import { generateResponseCursor } from "../../protocol/cursor";
import { base64Encode } from "../../protocol/encoding";
import {
  LONG_POLL_CACHE_SECONDS,
  LONG_POLL_TIMEOUT_MS,
  MAX_CHUNK_BYTES,
  SSE_RECONNECT_MS,
} from "../../protocol/limits";
import { ZERO_OFFSET } from "../../protocol/offsets";
import { applyExpiryHeaders } from "../../protocol/expiry";
import type { StreamMeta } from "../../storage/types";
import type { StreamContext } from "../router";

// ============================================================================
// SSE Types
// ============================================================================

export type SseClient = {
  id: number;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  offset: number;
  contentType: string;
  useBase64: boolean;
  closed: boolean;
  cursor: string;
  closeTimer?: number;
};

export type SseState = {
  clients: Map<number, SseClient>;
  nextId: number;
};

// ============================================================================
// LongPollQueue
// ============================================================================

export type Waiter = {
  offset: number;
  resolve: (result: { timedOut: boolean }) => void;
  timer: number;
};

// #region docs-long-poll-queue
export class LongPollQueue {
  private waiters: Waiter[] = [];

  async waitForData(offset: number, timeoutMs: number): Promise<boolean> {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        resolve(true);
      }, timeoutMs);

      const waiter: Waiter = {
        offset,
        timer: timer as unknown as number,
        resolve: (result) => resolve(result.timedOut),
      };

      this.waiters.push(waiter);
    });
  }

  notify(newTail: number): void {
    const ready = this.waiters.filter((w) => newTail > w.offset);
    this.waiters = this.waiters.filter((w) => newTail <= w.offset);

    for (const waiter of ready) {
      clearTimeout(waiter.timer);
      waiter.resolve({ timedOut: false });
    }
  }

  notifyAll(): void {
    const current = this.waiters;
    this.waiters = [];
    for (const waiter of current) {
      clearTimeout(waiter.timer);
      waiter.resolve({ timedOut: false });
    }
  }
}
// #endregion docs-long-poll-queue

const textEncoder = new TextEncoder();

// ============================================================================
// SSE Event Builders
// ============================================================================

// #region docs-sse-data-event
export function buildSseDataEvent(payload: ArrayBuffer, useBase64: boolean): string {
  let output = "event: data\n";

  if (useBase64) {
    const encoded = base64Encode(new Uint8Array(payload));
    output += `data:${encoded}\n\n`;
    return output;
  }

  const text = new TextDecoder().decode(payload);
  const lines = text.split(/\r\n|\n|\r/);
  for (const line of lines) {
    output += `data:${line}\n`;
  }
  output += "\n";
  return output;
}
// #endregion docs-sse-data-event

// #region docs-sse-control-event
export function buildSseControlEvent(params: {
  nextOffset: string;
  upToDate: boolean;
  streamClosed: boolean;
  cursor: string;
}): { payload: string; nextCursor: string | null } {
  const control: Record<string, unknown> = {
    streamNextOffset: params.nextOffset,
  };

  if (params.streamClosed) {
    control.streamClosed = true;
    return {
      payload: `event: control\n` + `data:${JSON.stringify(control)}\n\n`,
      nextCursor: null,
    };
  }

  const nextCursor = generateResponseCursor(params.cursor);
  control.streamCursor = nextCursor;
  if (params.upToDate) control.upToDate = true;

  return {
    payload: `event: control\n` + `data:${JSON.stringify(control)}\n\n`,
    nextCursor,
  };
}
// #endregion docs-sse-control-event

// ============================================================================
// Long-Poll Headers
// ============================================================================

export function buildLongPollHeaders(params: {
  meta: StreamMeta;
  nextOffsetHeader: string;
  upToDate: boolean;
  closedAtTail: boolean;
  cursor: string | null;
}): Headers {
  const headers = baseHeaders({
    "Content-Type": params.meta.content_type,
    [HEADER_STREAM_NEXT_OFFSET]: params.nextOffsetHeader,
  });
  if (params.cursor) headers.set(HEADER_STREAM_CURSOR, params.cursor);
  if (params.upToDate) headers.set(HEADER_STREAM_UP_TO_DATE, "true");
  if (params.closedAtTail) headers.set(HEADER_STREAM_CLOSED, "true");
  applyExpiryHeaders(headers, params.meta);
  return headers;
}

// ============================================================================
// Long-Poll Handler
// ============================================================================

// #region docs-long-poll-setup
export async function handleLongPoll(
  ctx: StreamContext,
  streamId: string,
  meta: StreamMeta,
  url: URL,
): Promise<Response> {
  const offsetParam = url.searchParams.get("offset");
  if (!offsetParam) return errorResponse(400, "offset is required");
  const cacheMode = ctx.cacheMode;
  let cacheControl =
    cacheMode === "shared" ? `public, max-age=${LONG_POLL_CACHE_SECONDS}` : "private, no-store";
  let offset: number;
  if (offsetParam === "now") {
    offset = meta.tail_offset;
    cacheControl = cacheMode === "shared" ? "no-store" : "private, no-store";
  } else {
    const resolved = await ctx.resolveOffset(
      streamId,
      meta,
      offsetParam === "-1" ? ZERO_OFFSET : offsetParam,
    );
    if (resolved.error) return resolved.error;
    offset = resolved.offset;
  }

  if (meta.closed === 1 && offset >= meta.tail_offset) {
    const headers = buildLongPollHeaders({
      meta,
      nextOffsetHeader: await ctx.encodeTailOffset(streamId, meta),
      upToDate: true,
      closedAtTail: true,
      cursor: null,
    });
    headers.set("Cache-Control", cacheControl);
    return new Response(null, { status: 204, headers });
  }
  // #endregion docs-long-poll-setup

  // #region docs-long-poll-immediate
  const initialRead = await ctx.readFromOffset(streamId, meta, offset, MAX_CHUNK_BYTES);
  if (initialRead.error) return initialRead.error;

  if (initialRead.hasData) {
    const headers = buildLongPollHeaders({
      meta,
      nextOffsetHeader: await ctx.encodeOffset(streamId, meta, initialRead.nextOffset),
      upToDate: initialRead.upToDate,
      closedAtTail: initialRead.closedAtTail,
      cursor: generateResponseCursor(url.searchParams.get("cursor")),
    });
    headers.set("Cache-Control", cacheControl);
    return new Response(initialRead.body, { status: 200, headers });
  }
  // #endregion docs-long-poll-immediate

  // #region docs-long-poll-wait
  const doneWait = ctx.timing?.start("longpoll.wait");
  const timedOut = await ctx.longPoll.waitForData(offset, LONG_POLL_TIMEOUT_MS);
  doneWait?.();
  const current = await ctx.getStream(streamId);
  if (!current) return errorResponse(404, "stream not found");

  if (timedOut) {
    const headers = buildLongPollHeaders({
      meta: current,
      nextOffsetHeader: await ctx.encodeTailOffset(streamId, current),
      upToDate: true,
      closedAtTail: current.closed === 1 && current.tail_offset === offset,
      cursor: generateResponseCursor(url.searchParams.get("cursor")),
    });
    headers.set("Cache-Control", cacheControl);
    return new Response(null, { status: 204, headers });
  }

  const read = await ctx.readFromOffset(streamId, current, offset, MAX_CHUNK_BYTES);
  if (read.error) return read.error;

  const headers = buildLongPollHeaders({
    meta: current,
    nextOffsetHeader: await ctx.encodeOffset(streamId, current, read.nextOffset),
    upToDate: read.upToDate,
    closedAtTail: read.closedAtTail,
    cursor: generateResponseCursor(url.searchParams.get("cursor")),
  });

  if (!read.hasData) {
    headers.set("Cache-Control", cacheControl);
    return new Response(null, { status: 204, headers });
  }

  headers.set("Cache-Control", cacheControl);
  return new Response(read.body, { status: 200, headers });
}
// #endregion docs-long-poll-wait

// ============================================================================
// SSE Handler
// ============================================================================

// #region docs-sse-setup
export async function handleSse(
  ctx: StreamContext,
  streamId: string,
  meta: StreamMeta,
  url: URL,
): Promise<Response> {
  const cacheMode = ctx.cacheMode;
  const offsetParam = url.searchParams.get("offset");
  if (!offsetParam) return errorResponse(400, "offset is required");
  let offset: number;
  if (offsetParam === "now") {
    offset = meta.tail_offset;
  } else {
    const resolved = await ctx.resolveOffset(
      streamId,
      meta,
      offsetParam === "-1" ? ZERO_OFFSET : offsetParam,
    );
    if (resolved.error) return resolved.error;
    offset = resolved.offset;
  }
  const contentType = meta.content_type;
  const useBase64 = !isTextual(contentType);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const clientId = ctx.sseState.nextId++;
  const client: SseClient = {
    id: clientId,
    writer,
    offset,
    contentType,
    useBase64,
    closed: false,
    cursor: url.searchParams.get("cursor") ?? "",
  };

  ctx.sseState.clients.set(clientId, client);
  // #endregion docs-sse-setup

  // #region docs-sse-lifecycle
  client.closeTimer = setTimeout(async () => {
    if (client.closed) return;
    await closeSseClient(ctx, client);
  }, SSE_RECONNECT_MS) as unknown as number;

  const headers = baseHeaders({
    "Content-Type": "text/event-stream",
    "Cache-Control": cacheMode === "shared" ? "no-cache" : "private, no-store, no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    [HEADER_STREAM_NEXT_OFFSET]: await ctx.encodeTailOffset(streamId, meta),
  });

  if (useBase64) headers.set(HEADER_SSE_DATA_ENCODING, "base64");

  ctx.state.waitUntil(
    (async () => {
      await Promise.resolve();
      await runSseSession(ctx, streamId, meta, client);
    })(),
  );

  return new Response(readable, { status: 200, headers });
}
// #endregion docs-sse-lifecycle

// ============================================================================
// SSE Broadcast
// ============================================================================

// #region docs-broadcast-sse
export async function broadcastSse(
  ctx: StreamContext,
  streamId: string,
  meta: StreamMeta,
  contentType: string,
  payload: ArrayBuffer | null,
  nextOffset: number,
  streamClosed: boolean,
): Promise<void> {
  if (!payload) return;

  const nextOffsetHeader = await ctx.encodeOffset(streamId, meta, nextOffset);
  const entries = Array.from(ctx.sseState.clients.values());
  for (const client of entries) {
    if (client.closed) continue;
    await writeSseData(client, payload, nextOffsetHeader, true, streamClosed);
    client.offset = nextOffset;
    if (streamClosed) {
      await closeSseClient(ctx, client);
    }
  }
}
// #endregion docs-broadcast-sse

export async function broadcastSseControl(
  ctx: StreamContext,
  streamId: string,
  meta: StreamMeta,
  nextOffset: number,
  streamClosed: boolean,
): Promise<void> {
  const nextOffsetHeader = await ctx.encodeOffset(streamId, meta, nextOffset);
  const entries = Array.from(ctx.sseState.clients.values());
  for (const client of entries) {
    if (client.closed) continue;
    await writeSseControl(client, nextOffsetHeader, true, streamClosed);
    client.offset = nextOffset;
    if (streamClosed) {
      await closeSseClient(ctx, client);
    }
  }
}

export async function closeAllSseClients(ctx: StreamContext): Promise<void> {
  const entries = Array.from(ctx.sseState.clients.values());
  for (const client of entries) {
    await closeSseClient(ctx, client);
  }
}

// ============================================================================
// SSE Session
// ============================================================================

async function runSseSession(
  ctx: StreamContext,
  streamId: string,
  meta: StreamMeta,
  client: SseClient,
): Promise<void> {
  try {
    let currentOffset = client.offset;
    let read = await ctx.readFromOffset(streamId, meta, currentOffset, MAX_CHUNK_BYTES);
    if (read.error) {
      await closeSseClient(ctx, client);
      return;
    }

    if (read.hasData) {
      const nextOffsetHeader = await ctx.encodeOffset(streamId, meta, read.nextOffset);
      await writeSseData(client, read.body, nextOffsetHeader, read.upToDate, read.closedAtTail);
      currentOffset = read.nextOffset;
      client.offset = currentOffset;

      while (!read.upToDate && !read.closedAtTail) {
        read = await ctx.readFromOffset(streamId, meta, currentOffset, MAX_CHUNK_BYTES);
        if (read.error) break;
        if (!read.hasData) break;
        const header = await ctx.encodeOffset(streamId, meta, read.nextOffset);
        await writeSseData(client, read.body, header, read.upToDate, read.closedAtTail);
        currentOffset = read.nextOffset;
        client.offset = currentOffset;
      }
    } else {
      const header = await ctx.encodeOffset(streamId, meta, currentOffset);
      await writeSseControl(
        client,
        header,
        true,
        meta.closed === 1 && currentOffset >= meta.tail_offset,
      );
    }

    if (meta.closed === 1 && currentOffset >= meta.tail_offset) {
      await closeSseClient(ctx, client);
    }
  } catch {
    await closeSseClient(ctx, client);
  }
}

async function closeSseClient(ctx: StreamContext, client: SseClient): Promise<void> {
  if (client.closed) return;
  client.closed = true;
  if (client.closeTimer) clearTimeout(client.closeTimer);
  try {
    await client.writer.close();
  } finally {
    ctx.sseState.clients.delete(client.id);
  }
}

async function writeSseData(
  client: SseClient,
  payload: ArrayBuffer,
  nextOffsetHeader: string,
  upToDate: boolean,
  streamClosed: boolean,
): Promise<void> {
  const dataEvent = buildSseDataEvent(payload, client.useBase64);
  const control = buildSseControlEvent({
    nextOffset: nextOffsetHeader,
    upToDate,
    streamClosed,
    cursor: client.cursor,
  });
  if (control.nextCursor) client.cursor = control.nextCursor;
  await client.writer.write(textEncoder.encode(dataEvent + control.payload));
}

async function writeSseControl(
  client: SseClient,
  nextOffsetHeader: string,
  upToDate: boolean,
  streamClosed: boolean,
): Promise<void> {
  const control = buildSseControlEvent({
    nextOffset: nextOffsetHeader,
    upToDate,
    streamClosed,
    cursor: client.cursor,
  });
  if (control.nextCursor) client.cursor = control.nextCursor;
  await client.writer.write(textEncoder.encode(control.payload));
}
