import {
  HEADER_SSE_DATA_ENCODING,
  HEADER_STREAM_NEXT_OFFSET,
  baseHeaders,
  isTextual,
} from "../../protocol/headers";
import { errorResponse } from "../../protocol/errors";
import { generateResponseCursor } from "../../protocol/cursor";
import {
  LONG_POLL_CACHE_SECONDS,
  LONG_POLL_TIMEOUT_MS,
  MAX_CHUNK_BYTES,
  SSE_RECONNECT_MS,
} from "../../protocol/limits";
import { buildSseControlEvent, buildSseDataEvent } from "../../live/sse";
import { buildLongPollHeaders } from "../../engine/stream";
import type { StreamMeta } from "../../storage/storage";
import type { StreamContext } from "../context";
import type { SseClient } from "../../live/types";

export async function handleLongPoll(
  ctx: StreamContext,
  streamId: string,
  meta: StreamMeta,
  url: URL,
): Promise<Response> {
  const offsetParam = url.searchParams.get("offset");
  if (!offsetParam) return errorResponse(400, "offset is required");

  const resolved = await ctx.resolveOffset(streamId, meta, offsetParam);
  if (resolved.error) return resolved.error;

  const offset = resolved.offset;

  if (meta.closed === 1 && offset >= meta.tail_offset) {
    const headers = buildLongPollHeaders({
      meta,
      nextOffsetHeader: ctx.encodeTailOffset(meta),
      upToDate: true,
      closedAtTail: true,
      cursor: null,
    });
    headers.set("Cache-Control", `public, max-age=${LONG_POLL_CACHE_SECONDS}`);
    return new Response(null, { status: 204, headers });
  }

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
    headers.set("Cache-Control", `public, max-age=${LONG_POLL_CACHE_SECONDS}`);
    return new Response(initialRead.body, { status: 200, headers });
  }

  const doneWait = ctx.timing?.start("longpoll.wait");
  const timedOut = await ctx.longPoll.waitForData(offset, LONG_POLL_TIMEOUT_MS);
  doneWait?.();
  const current = await ctx.getStream(streamId);
  if (!current) return errorResponse(404, "stream not found");

  if (timedOut) {
    const headers = buildLongPollHeaders({
      meta: current,
      nextOffsetHeader: ctx.encodeTailOffset(current),
      upToDate: true,
      closedAtTail: current.closed === 1 && current.tail_offset === offset,
      cursor: generateResponseCursor(url.searchParams.get("cursor")),
    });
    headers.set("Cache-Control", `public, max-age=${LONG_POLL_CACHE_SECONDS}`);
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
    headers.set("Cache-Control", `public, max-age=${LONG_POLL_CACHE_SECONDS}`);
    return new Response(null, { status: 204, headers });
  }

  headers.set("Cache-Control", `public, max-age=${LONG_POLL_CACHE_SECONDS}`);
  return new Response(read.body, { status: 200, headers });
}

export async function handleSse(
  ctx: StreamContext,
  streamId: string,
  meta: StreamMeta,
  url: URL,
): Promise<Response> {
  const offsetParam = url.searchParams.get("offset");
  if (!offsetParam) return errorResponse(400, "offset is required");

  const resolved = await ctx.resolveOffset(streamId, meta, offsetParam);
  if (resolved.error) return resolved.error;

  const offset = resolved.offset;
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

  client.closeTimer = setTimeout(async () => {
    if (client.closed) return;
    await closeSseClient(ctx, client);
  }, SSE_RECONNECT_MS) as unknown as number;

  const headers = baseHeaders({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    [HEADER_STREAM_NEXT_OFFSET]: ctx.encodeTailOffset(meta),
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
  const encoder = new TextEncoder();
  const dataEvent = buildSseDataEvent(payload, client.useBase64);
  const control = buildSseControlEvent({
    nextOffset: nextOffsetHeader,
    upToDate,
    streamClosed,
    cursor: client.cursor,
  });
  if (control.nextCursor) client.cursor = control.nextCursor;
  await client.writer.write(encoder.encode(dataEvent + control.payload));
}

async function writeSseControl(
  client: SseClient,
  nextOffsetHeader: string,
  upToDate: boolean,
  streamClosed: boolean,
): Promise<void> {
  const encoder = new TextEncoder();
  const control = buildSseControlEvent({
    nextOffset: nextOffsetHeader,
    upToDate,
    streamClosed,
    cursor: client.cursor,
  });
  if (control.nextCursor) client.cursor = control.nextCursor;
  await client.writer.write(encoder.encode(control.payload));
}
