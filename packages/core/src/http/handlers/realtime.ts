import {
  HEADER_SSE_DATA_ENCODING,
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_NEXT_OFFSET,
  HEADER_STREAM_UP_TO_DATE,
  HEADER_STREAM_CURSOR,
  HEADER_STREAM_WRITE_TIMESTAMP,
  baseHeaders,
  isTextual,
} from "../../protocol/headers";
import { errorResponse } from "../../protocol/errors";
import { buildEtag } from "../../protocol/etag";
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
// WebSocket Types (Internal WS Bridge)
// ============================================================================

export type WsAttachment = {
  offset: number;
  contentType: string;
  useBase64: boolean;
  cursor: string;
  streamId: string;
};

export type WsDataMessage = {
  type: "data";
  payload: string;
  encoding?: "base64";
};

export type WsControlMessage = {
  type: "control";
  streamNextOffset: string;
  upToDate?: boolean;
  streamClosed?: boolean;
  streamCursor?: string;
  streamWriteTimestamp?: number;
};

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
  url: string;
  resolve: (result: { timedOut: boolean }) => void;
  timer: number;
};

// #region docs-long-poll-queue
export class LongPollQueue {
  private waiters: Waiter[] = [];

  async waitForData(offset: number, url: string, timeoutMs: number): Promise<boolean> {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        resolve(true);
      }, timeoutMs);

      const waiter: Waiter = {
        offset,
        url,
        timer: timer as unknown as number,
        resolve: (result) => resolve(result.timedOut),
      };

      this.waiters.push(waiter);
    });
  }

  notify(newTail: number, staggerMs = 0): void {
    const ready = this.waiters.filter((w) => newTail > w.offset);
    this.waiters = this.waiters.filter((w) => newTail <= w.offset);

    if (staggerMs <= 0 || ready.length <= 1) {
      for (const waiter of ready) {
        clearTimeout(waiter.timer);
        waiter.resolve({ timedOut: false });
      }
      return;
    }

    // Resolve first waiter immediately (the "scout") so its Worker
    // caches the response before the rest reconnect.
    clearTimeout(ready[0].timer);
    ready[0].resolve({ timedOut: false });

    // Spread remaining over [0, staggerMs] random window.
    for (let i = 1; i < ready.length; i++) {
      const delay = Math.random() * staggerMs;
      setTimeout(() => {
        clearTimeout(ready[i].timer);
        ready[i].resolve({ timedOut: false });
      }, delay);
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

  /**
   * Return unique URLs of waiters that would be resolved by a new tail offset.
   * Used by the write handler to pre-cache responses before resolving waiters.
   */
  getReadyWaiterUrls(newTail: number): string[] {
    const urls = new Set<string>();
    for (const w of this.waiters) {
      if (newTail > w.offset) urls.add(w.url);
    }
    return [...urls];
  }

  getWaiterCount(): number {
    return this.waiters.length;
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
  writeTimestamp?: number;
}): { payload: string; nextCursor: string | null } {
  const control: Record<string, unknown> = {
    streamNextOffset: params.nextOffset,
  };

  if (params.writeTimestamp && params.writeTimestamp > 0) {
    control.streamWriteTimestamp = params.writeTimestamp;
  }

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
  writeTimestamp?: number;
}): Headers {
  const headers = baseHeaders({
    "Content-Type": params.meta.content_type,
    [HEADER_STREAM_NEXT_OFFSET]: params.nextOffsetHeader,
  });
  if (params.cursor) headers.set(HEADER_STREAM_CURSOR, params.cursor);
  if (params.upToDate) headers.set(HEADER_STREAM_UP_TO_DATE, "true");
  if (params.closedAtTail) headers.set(HEADER_STREAM_CLOSED, "true");
  if (params.writeTimestamp && params.writeTimestamp > 0) {
    headers.set(HEADER_STREAM_WRITE_TIMESTAMP, String(params.writeTimestamp));
  }
  applyExpiryHeaders(headers, params.meta);
  return headers;
}

// ============================================================================
// Long-Poll Pre-Cache (for write-time cache warming)
// ============================================================================

/**
 * Build a cacheable long-poll response for the given offset/cursor.
 * Used by the write handler to pre-populate caches.default BEFORE
 * resolving long-poll waiters, so edge Workers in the same colo find
 * the entry on their next cache check.
 *
 * Returns null if no data is available at the offset.
 */
export async function buildPreCacheResponse(
  ctx: StreamContext,
  streamId: string,
  meta: StreamMeta,
  offset: number,
  cursor: string | null,
): Promise<Response | null> {
  const read = await ctx.readFromOffset(streamId, meta, offset, MAX_CHUNK_BYTES);
  if (read.error || !read.hasData) return null;

  const headers = buildLongPollHeaders({
    meta,
    nextOffsetHeader: await ctx.encodeOffset(streamId, meta, read.nextOffset),
    upToDate: read.upToDate,
    closedAtTail: read.closedAtTail,
    cursor: generateResponseCursor(cursor),
    writeTimestamp: read.writeTimestamp,
  });
  headers.set("Cache-Control", `public, max-age=${LONG_POLL_CACHE_SECONDS}`);
  headers.set("ETag", buildEtag(streamId, offset, read.nextOffset, read.closedAtTail));
  return new Response(read.body, { status: 200, headers });
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
  let cacheControl = `public, max-age=${LONG_POLL_CACHE_SECONDS}`;
  let offset: number;
  if (offsetParam === "now") {
    offset = meta.tail_offset;
    cacheControl = "no-store";
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
      writeTimestamp: initialRead.writeTimestamp,
    });
    headers.set("Cache-Control", cacheControl);
    headers.set("ETag", buildEtag(streamId, offset, initialRead.nextOffset, initialRead.closedAtTail));
    return new Response(initialRead.body, { status: 200, headers });
  }
  // #endregion docs-long-poll-immediate

  // #region docs-long-poll-wait
  const doneWait = ctx.timing?.start("longpoll.wait");
  const timedOut = await ctx.longPoll.waitForData(offset, url.toString(), LONG_POLL_TIMEOUT_MS);
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
    writeTimestamp: read.writeTimestamp,
  });

  if (!read.hasData) {
    headers.set("Cache-Control", cacheControl);
    return new Response(null, { status: 204, headers });
  }

  headers.set("Cache-Control", cacheControl);
  headers.set("ETag", buildEtag(streamId, offset, read.nextOffset, read.closedAtTail));
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

  // Record metrics for SSE connection
  if (ctx.env.METRICS) {
    ctx.env.METRICS.writeDataPoint({
      indexes: [streamId],
      blobs: [streamId, "sse_connect", "anonymous"],
      doubles: [1, 0],
    });
  }
  // #endregion docs-sse-setup

  // #region docs-sse-lifecycle
  client.closeTimer = setTimeout(async () => {
    if (client.closed) return;
    await closeSseClient(ctx, client);
  }, SSE_RECONNECT_MS) as unknown as number;

  const headers = baseHeaders({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
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
  writeTimestamp: number = 0,
): Promise<void> {
  if (!payload) return;

  const nextOffsetHeader = await ctx.encodeOffset(streamId, meta, nextOffset);
  const entries = Array.from(ctx.sseState.clients.values());
  for (const client of entries) {
    if (client.closed) continue;
    await writeSseData(client, payload, nextOffsetHeader, true, streamClosed, writeTimestamp);
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
  writeTimestamp: number = 0,
): Promise<void> {
  const nextOffsetHeader = await ctx.encodeOffset(streamId, meta, nextOffset);
  const entries = Array.from(ctx.sseState.clients.values());
  for (const client of entries) {
    if (client.closed) continue;
    await writeSseControl(client, nextOffsetHeader, true, streamClosed, writeTimestamp);
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
      await writeSseData(client, read.body, nextOffsetHeader, read.upToDate, read.closedAtTail, read.writeTimestamp);
      currentOffset = read.nextOffset;
      client.offset = currentOffset;

      while (!read.upToDate && !read.closedAtTail) {
        read = await ctx.readFromOffset(streamId, meta, currentOffset, MAX_CHUNK_BYTES);
        if (read.error) break;
        if (!read.hasData) break;
        const header = await ctx.encodeOffset(streamId, meta, read.nextOffset);
        await writeSseData(client, read.body, header, read.upToDate, read.closedAtTail, read.writeTimestamp);
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
  writeTimestamp: number = 0,
): Promise<void> {
  const dataEvent = buildSseDataEvent(payload, client.useBase64);
  const control = buildSseControlEvent({
    nextOffset: nextOffsetHeader,
    upToDate,
    streamClosed,
    cursor: client.cursor,
    writeTimestamp,
  });
  if (control.nextCursor) client.cursor = control.nextCursor;
  await client.writer.write(textEncoder.encode(dataEvent + control.payload));
}

async function writeSseControl(
  client: SseClient,
  nextOffsetHeader: string,
  upToDate: boolean,
  streamClosed: boolean,
  writeTimestamp: number = 0,
): Promise<void> {
  const control = buildSseControlEvent({
    nextOffset: nextOffsetHeader,
    upToDate,
    streamClosed,
    cursor: client.cursor,
    writeTimestamp,
  });
  if (control.nextCursor) client.cursor = control.nextCursor;
  await client.writer.write(textEncoder.encode(control.payload));
}

// ============================================================================
// WebSocket Internal Bridge — Message Builders
// ============================================================================

export function buildWsDataMessage(payload: ArrayBuffer, useBase64: boolean): WsDataMessage {
  if (useBase64) {
    return {
      type: "data",
      payload: base64Encode(new Uint8Array(payload)),
      encoding: "base64",
    };
  }
  return {
    type: "data",
    payload: new TextDecoder().decode(payload),
  };
}

export function buildWsControlMessage(params: {
  nextOffset: string;
  upToDate: boolean;
  streamClosed: boolean;
  cursor: string;
  writeTimestamp?: number;
}): { message: WsControlMessage; nextCursor: string | null } {
  const msg: WsControlMessage = {
    type: "control",
    streamNextOffset: params.nextOffset,
  };

  if (params.writeTimestamp && params.writeTimestamp > 0) {
    msg.streamWriteTimestamp = params.writeTimestamp;
  }

  if (params.streamClosed) {
    msg.streamClosed = true;
    return { message: msg, nextCursor: null };
  }

  const nextCursor = generateResponseCursor(params.cursor);
  msg.streamCursor = nextCursor;
  if (params.upToDate) msg.upToDate = true;

  return { message: msg, nextCursor };
}

// ============================================================================
// WebSocket Internal Bridge — Upgrade Handler
// ============================================================================

export async function handleWsUpgrade(
  ctx: StreamContext,
  streamId: string,
  meta: StreamMeta,
  url: URL,
  request: Request,
): Promise<Response> {
  const upgradeHeader = request.headers.get("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return errorResponse(426, "WebSocket upgrade required");
  }

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
  const cursor = url.searchParams.get("cursor") ?? "";

  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];

  const attachment: WsAttachment = {
    offset,
    contentType,
    useBase64,
    cursor,
    streamId,
  };

  ctx.state.acceptWebSocket(server, [streamId]);
  server.serializeAttachment(attachment);

  // Send catch-up data in the background after returning the 101
  ctx.state.waitUntil(
    (async () => {
      await Promise.resolve();
      await sendWsCatchUp(ctx, streamId, meta, server, attachment);
    })(),
  );

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  if (useBase64) headers.set(HEADER_SSE_DATA_ENCODING, "base64");

  return new Response(null, { status: 101, webSocket: client, headers });
}

// ============================================================================
// WebSocket Internal Bridge — Catch-Up + Broadcast
// ============================================================================

async function sendWsCatchUp(
  ctx: StreamContext,
  streamId: string,
  meta: StreamMeta,
  ws: WebSocket,
  attachment: WsAttachment,
): Promise<void> {
  try {
    let currentOffset = attachment.offset;
    let read = await ctx.readFromOffset(streamId, meta, currentOffset, MAX_CHUNK_BYTES);
    if (read.error) return;

    if (read.hasData) {
      sendWsData(ws, attachment, read.body);
      const nextOffsetHeader = await ctx.encodeOffset(streamId, meta, read.nextOffset);
      sendWsControl(ws, attachment, nextOffsetHeader, read.upToDate, read.closedAtTail, read.writeTimestamp);
      currentOffset = read.nextOffset;
      attachment.offset = currentOffset;

      while (!read.upToDate && !read.closedAtTail) {
        read = await ctx.readFromOffset(streamId, meta, currentOffset, MAX_CHUNK_BYTES);
        if (read.error || !read.hasData) break;
        sendWsData(ws, attachment, read.body);
        const header = await ctx.encodeOffset(streamId, meta, read.nextOffset);
        sendWsControl(ws, attachment, header, read.upToDate, read.closedAtTail, read.writeTimestamp);
        currentOffset = read.nextOffset;
        attachment.offset = currentOffset;
      }
    } else {
      const header = await ctx.encodeOffset(streamId, meta, currentOffset);
      const closedAtTail = meta.closed === 1 && currentOffset >= meta.tail_offset;
      sendWsControl(ws, attachment, header, true, closedAtTail);
    }

    ws.serializeAttachment(attachment);

    if (meta.closed === 1 && currentOffset >= meta.tail_offset) {
      ws.close(1000, "stream closed");
    }
  } catch {
    try { ws.close(1011, "catch-up error"); } catch { /* already closed */ }
  }
}

function sendWsData(ws: WebSocket, attachment: WsAttachment, payload: ArrayBuffer): void {
  const msg = buildWsDataMessage(payload, attachment.useBase64);
  ws.send(JSON.stringify(msg));
}

function sendWsControl(
  ws: WebSocket,
  attachment: WsAttachment,
  nextOffsetHeader: string,
  upToDate: boolean,
  streamClosed: boolean,
  writeTimestamp: number = 0,
): void {
  const { message, nextCursor } = buildWsControlMessage({
    nextOffset: nextOffsetHeader,
    upToDate,
    streamClosed,
    cursor: attachment.cursor,
    writeTimestamp,
  });
  if (nextCursor) attachment.cursor = nextCursor;
  ws.send(JSON.stringify(message));
}

// ============================================================================
// WebSocket Internal Bridge — Broadcast (called from write handlers)
// ============================================================================

export async function broadcastWebSocket(
  ctx: StreamContext,
  streamId: string,
  meta: StreamMeta,
  contentType: string,
  payload: ArrayBuffer | null,
  nextOffset: number,
  streamClosed: boolean,
  writeTimestamp: number = 0,
): Promise<void> {
  const sockets = ctx.getWebSockets(streamId);
  if (sockets.length === 0) return;
  if (!payload) return;

  const nextOffsetHeader = await ctx.encodeOffset(streamId, meta, nextOffset);

  for (const ws of sockets) {
    try {
      const attachment = ws.deserializeAttachment() as WsAttachment;
      sendWsData(ws, attachment, payload);

      const { message, nextCursor } = buildWsControlMessage({
        nextOffset: nextOffsetHeader,
        upToDate: true,
        streamClosed,
        cursor: attachment.cursor,
        writeTimestamp,
      });
      if (nextCursor) attachment.cursor = nextCursor;
      attachment.offset = nextOffset;
      ws.serializeAttachment(attachment);
      ws.send(JSON.stringify(message));

      if (streamClosed) {
        ws.close(1000, "stream closed");
      }
    } catch {
      try { ws.close(1011, "broadcast error"); } catch { /* already closed */ }
    }
  }
}

export async function broadcastWebSocketControl(
  ctx: StreamContext,
  streamId: string,
  meta: StreamMeta,
  nextOffset: number,
  streamClosed: boolean,
  writeTimestamp: number = 0,
): Promise<void> {
  const sockets = ctx.getWebSockets(streamId);
  if (sockets.length === 0) return;

  const nextOffsetHeader = await ctx.encodeOffset(streamId, meta, nextOffset);

  for (const ws of sockets) {
    try {
      const attachment = ws.deserializeAttachment() as WsAttachment;
      const { message, nextCursor } = buildWsControlMessage({
        nextOffset: nextOffsetHeader,
        upToDate: true,
        streamClosed,
        cursor: attachment.cursor,
        writeTimestamp,
      });
      if (nextCursor) attachment.cursor = nextCursor;
      attachment.offset = nextOffset;
      ws.serializeAttachment(attachment);
      ws.send(JSON.stringify(message));

      if (streamClosed) {
        ws.close(1000, "stream closed");
      }
    } catch {
      try { ws.close(1011, "broadcast error"); } catch { /* already closed */ }
    }
  }
}

export function closeAllWebSockets(ctx: StreamContext): void {
  const sockets = ctx.getWebSockets();
  for (const ws of sockets) {
    try { ws.close(1000, "stream deleted"); } catch { /* already closed */ }
  }
}
