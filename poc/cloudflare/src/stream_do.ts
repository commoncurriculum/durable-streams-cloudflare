import {
  HEADER_PRODUCER_EPOCH,
  HEADER_PRODUCER_SEQ,
  HEADER_SSE_DATA_ENCODING,
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_EXPIRES_AT,
  HEADER_STREAM_NEXT_OFFSET,
  HEADER_STREAM_SEQ,
  HEADER_STREAM_TTL,
  HEADER_STREAM_UP_TO_DATE,
  baseHeaders,
  isJsonContentType,
  isTextual,
  normalizeContentType,
} from "./protocol/headers";
import {
  LONG_POLL_TIMEOUT_MS,
  MAX_APPEND_BYTES,
  MAX_CHUNK_BYTES,
  SSE_RECONNECT_MS,
} from "./protocol/limits";
import {
  applyExpiryHeaders,
  isExpired,
  parseExpiresAt,
  parseTtlSeconds,
  ttlMatches,
} from "./protocol/expiry";
import { errorResponse } from "./protocol/errors";
import { generateResponseCursor } from "./protocol/cursor";
import { concatBuffers, toUint8Array } from "./protocol/encoding";
import { decodeOffset, encodeOffset } from "./protocol/offsets";
import { LongPollQueue } from "./live/long_poll";
import { buildSseControlEvent, buildSseDataEvent } from "./live/sse";
import {
  evaluateProducer,
  parseProducerHeaders,
  producerDuplicateResponse,
  type ProducerEval,
} from "./engine/producer";
import {
  buildAppendBatch,
  buildClosedConflict,
  buildHeadResponse,
  buildLongPollHeaders,
  buildNowResponse,
  buildPutHeaders,
  buildReadResponse,
  parseContentType,
  readFromOffset,
  validateStreamSeq,
} from "./engine/stream";
import { D1Storage } from "./storage/d1";
import type { StreamMeta } from "./storage/storage";

type SseClient = {
  id: number;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  offset: number;
  contentType: string;
  useBase64: boolean;
  closed: boolean;
  cursor: string;
  closeTimer?: number;
};

export interface Env {
  DB: D1Database;
  R2?: R2Bucket;
}

export class StreamDO {
  private state: DurableObjectState;
  private env: Env;
  private storage: D1Storage;
  private longPoll = new LongPollQueue();
  private sseClients: Map<number, SseClient> = new Map();
  private sseClientId = 0;

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

    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    try {
      if (method === "PUT") return await this.handlePut(streamId, request);
      if (method === "POST") return await this.handlePost(streamId, request);
      if (method === "GET") return await this.handleGet(streamId, request, url);
      if (method === "HEAD") return await this.handleHead(streamId);
      if (method === "DELETE") return await this.handleDelete(streamId);
      return errorResponse(405, "method not allowed");
    } catch (e) {
      return errorResponse(500, e instanceof Error ? e.message : "internal error");
    }
  }

  private async handlePut(streamId: string, request: Request): Promise<Response> {
    return this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const headerContentType = parseContentType(request);
      const requestedClosed = request.headers.get(HEADER_STREAM_CLOSED) === "true";
      const ttlHeader = request.headers.get(HEADER_STREAM_TTL);
      const expiresHeader = request.headers.get(HEADER_STREAM_EXPIRES_AT);

      if (ttlHeader && expiresHeader) {
        return errorResponse(400, "Stream-TTL and Stream-Expires-At are mutually exclusive");
      }

      const ttlSeconds = parseTtlSeconds(ttlHeader);
      if (ttlSeconds.error) return errorResponse(400, ttlSeconds.error);

      const expiresAt = parseExpiresAt(expiresHeader);
      if (expiresAt.error) return errorResponse(400, expiresAt.error);

      const effectiveExpiresAt =
        ttlSeconds.value !== null ? now + ttlSeconds.value * 1000 : expiresAt.value;

      let bodyBytes = new Uint8Array(await request.arrayBuffer());
      if (bodyBytes.length > MAX_APPEND_BYTES) {
        return errorResponse(413, "payload too large");
      }

      if (
        bodyBytes.length > 0 &&
        isJsonContentType(headerContentType ?? "application/octet-stream")
      ) {
        const text = new TextDecoder().decode(bodyBytes);
        try {
          const value = JSON.parse(text);
          if (Array.isArray(value) && value.length === 0) {
            bodyBytes = new Uint8Array();
          }
        } catch {
          // invalid JSON handled later in append path
        }
      }

      const existing = await this.getStream(streamId);
      if (existing) {
        const contentType = headerContentType ?? existing.content_type;
        if (normalizeContentType(existing.content_type) !== contentType) {
          return errorResponse(409, "content-type mismatch");
        }
        if (requestedClosed !== (existing.closed === 1)) {
          return errorResponse(409, "stream closed status mismatch");
        }
        if (!ttlMatches(existing, ttlSeconds.value, effectiveExpiresAt)) {
          return errorResponse(409, "stream TTL/expiry mismatch");
        }

        const headers = buildPutHeaders(existing);
        return new Response(null, { status: 200, headers });
      }

      const contentType = headerContentType ?? "application/octet-stream";

      await this.storage.insertStream({
        streamId,
        contentType,
        closed: requestedClosed,
        ttlSeconds: ttlSeconds.value,
        expiresAt: effectiveExpiresAt,
        createdAt: now,
      });

      let tailOffset = 0;

      const producer = parseProducerHeaders(request);
      if (producer && producer.error) return producer.error;

      if (producer?.value) {
        const producerEval = await evaluateProducer(this.storage, streamId, producer.value);
        if (producerEval.kind === "error") return producerEval.response;
      }

      if (bodyBytes.length > 0) {
        const append = await buildAppendBatch(this.storage, streamId, contentType, bodyBytes, {
          streamSeq: request.headers.get(HEADER_STREAM_SEQ),
          producer: producer?.value ?? null,
          closeStream: requestedClosed,
        });

        if (append.error) return append.error;
        await this.storage.batch(append.statements);
        tailOffset = append.newTailOffset;
      }

      const headers = buildPutHeaders({
        stream_id: streamId,
        content_type: contentType,
        closed: requestedClosed ? 1 : 0,
        tail_offset: tailOffset,
        last_stream_seq: null,
        ttl_seconds: ttlSeconds.value,
        expires_at: effectiveExpiresAt,
        created_at: now,
        closed_at: requestedClosed ? now : null,
      });
      headers.set("Location", request.url);

      if (requestedClosed) {
        this.state.waitUntil(this.snapshotToR2(streamId, contentType, tailOffset));
      }

      return new Response(null, { status: 201, headers });
    });
  }

  private async handlePost(streamId: string, request: Request): Promise<Response> {
    return this.state.blockConcurrencyWhile(async () => {
      const meta = await this.getStream(streamId);
      if (!meta) return errorResponse(404, "stream not found");

      const closeStream = request.headers.get(HEADER_STREAM_CLOSED) === "true";

      const bodyBytes = new Uint8Array(await request.arrayBuffer());
      if (bodyBytes.length > MAX_APPEND_BYTES) {
        return errorResponse(413, "payload too large");
      }

      const producer = parseProducerHeaders(request);
      if (producer && producer.error) return producer.error;

      let producerEval: ProducerEval = { kind: "none" };
      if (producer?.value) {
        producerEval = await evaluateProducer(this.storage, streamId, producer.value);
        if (producerEval.kind === "error") return producerEval.response;
        if (producerEval.kind === "duplicate") {
          return producerDuplicateResponse(producerEval.state, meta.closed === 1);
        }
      }

      if (bodyBytes.length === 0 && closeStream) {
        if (meta.closed === 1 && producer?.value) {
          return buildClosedConflict(meta);
        }

        if (!meta.closed) {
          await this.storage.closeStream(streamId, Date.now());
        }

        if (producer?.value) {
          await this.storage.upsertProducer(streamId, producer.value, meta.tail_offset);
        }

        const headers = baseHeaders({
          [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(meta.tail_offset),
          [HEADER_STREAM_CLOSED]: "true",
        });

        if (producer?.value) {
          headers.set(HEADER_PRODUCER_EPOCH, producer.value.epoch.toString());
          headers.set(HEADER_PRODUCER_SEQ, producer.value.seq.toString());
        }

        this.longPoll.notify(meta.tail_offset);
        await this.broadcastSseControl(meta.tail_offset, true);
        this.state.waitUntil(this.snapshotToR2(streamId, meta.content_type, meta.tail_offset));
        return new Response(null, { status: 204, headers });
      }

      if (bodyBytes.length === 0) {
        return errorResponse(400, "empty body");
      }

      if (meta.closed === 1) {
        return buildClosedConflict(meta);
      }

      const contentType = parseContentType(request);
      if (!contentType) {
        return errorResponse(400, "Content-Type is required");
      }

      if (normalizeContentType(meta.content_type) !== contentType) {
        return errorResponse(409, "content-type mismatch");
      }

      const streamSeq = request.headers.get(HEADER_STREAM_SEQ);
      const seqError = validateStreamSeq(meta, streamSeq);
      if (seqError) return seqError;

      const append = await buildAppendBatch(this.storage, streamId, contentType, bodyBytes, {
        streamSeq,
        producer: producer?.value ?? null,
        closeStream,
      });

      if (append.error) return append.error;

      await this.storage.batch(append.statements);

      const headers = baseHeaders({
        [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(append.newTailOffset),
      });

      if (producer?.value) {
        headers.set(HEADER_PRODUCER_EPOCH, producer.value.epoch.toString());
        headers.set(HEADER_PRODUCER_SEQ, producer.value.seq.toString());
      }

      if (closeStream) headers.set(HEADER_STREAM_CLOSED, "true");

      this.longPoll.notify(append.newTailOffset);
      this.broadcastSse(contentType, append.ssePayload, append.newTailOffset, closeStream);
      if (closeStream) {
        this.state.waitUntil(this.snapshotToR2(streamId, contentType, append.newTailOffset));
      }

      const status = producer?.value ? 200 : 204;
      return new Response(null, { status, headers });
    });
  }

  private async handleGet(streamId: string, request: Request, url: URL): Promise<Response> {
    const meta = await this.getStream(streamId);
    if (!meta) return errorResponse(404, "stream not found");

    const live = url.searchParams.get("live");
    if (live === "long-poll") {
      return this.handleLongPoll(streamId, meta, url);
    }

    if (live === "sse") {
      return this.handleSse(streamId, meta, url);
    }

    const offsetParam = url.searchParams.get("offset");
    const resolved = this.resolveOffset(meta, offsetParam);
    if (resolved.error) return resolved.error;

    const { offset, isNow } = resolved;

    if (isNow) {
      return buildNowResponse(meta);
    }

    const read = await readFromOffset(this.storage, streamId, meta, offset, MAX_CHUNK_BYTES);
    if (read.error) return read.error;

    const response = buildReadResponse({
      streamId,
      meta,
      body: read.body,
      nextOffset: read.nextOffset,
      upToDate: read.upToDate,
      closedAtTail: read.closedAtTail,
      offset,
    });

    const ifNoneMatch = request.headers.get("If-None-Match");
    const etag = response.headers.get("ETag");
    if (ifNoneMatch && etag && ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: response.headers });
    }

    return response;
  }

  private async handleLongPoll(streamId: string, meta: StreamMeta, url: URL): Promise<Response> {
    const offsetParam = url.searchParams.get("offset");
    if (!offsetParam) return errorResponse(400, "offset is required");

    const resolved = this.resolveOffset(meta, offsetParam);
    if (resolved.error) return resolved.error;

    const offset = resolved.offset;

    if (meta.closed === 1 && offset >= meta.tail_offset) {
      const headers = baseHeaders({
        [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(meta.tail_offset),
        [HEADER_STREAM_UP_TO_DATE]: "true",
        [HEADER_STREAM_CLOSED]: "true",
      });
      headers.set("Cache-Control", "no-store");
      applyExpiryHeaders(headers, meta);
      return new Response(null, { status: 204, headers });
    }

    const initialRead = await readFromOffset(this.storage, streamId, meta, offset, MAX_CHUNK_BYTES);
    if (initialRead.error) return initialRead.error;

    if (initialRead.hasData) {
      const headers = buildLongPollHeaders({
        meta,
        nextOffset: initialRead.nextOffset,
        upToDate: initialRead.upToDate,
        closedAtTail: initialRead.closedAtTail,
        cursor: generateResponseCursor(url.searchParams.get("cursor")),
      });
      return new Response(initialRead.body, { status: 200, headers });
    }

    const timedOut = await this.longPoll.waitForData(offset, LONG_POLL_TIMEOUT_MS);
    const current = await this.getStream(streamId);
    if (!current) return errorResponse(404, "stream not found");

    if (timedOut) {
      const headers = buildLongPollHeaders({
        meta: current,
        nextOffset: current.tail_offset,
        upToDate: true,
        closedAtTail: current.closed === 1 && current.tail_offset === offset,
        cursor: generateResponseCursor(url.searchParams.get("cursor")),
      });
      headers.set("Cache-Control", "no-store");
      return new Response(null, { status: 204, headers });
    }

    const read = await readFromOffset(this.storage, streamId, current, offset, MAX_CHUNK_BYTES);
    if (read.error) return read.error;

    const headers = buildLongPollHeaders({
      meta: current,
      nextOffset: read.nextOffset,
      upToDate: read.upToDate,
      closedAtTail: read.closedAtTail,
      cursor: generateResponseCursor(url.searchParams.get("cursor")),
    });

    if (!read.hasData) {
      headers.set("Cache-Control", "no-store");
      return new Response(null, { status: 204, headers });
    }

    return new Response(read.body, { status: 200, headers });
  }

  private async handleSse(streamId: string, meta: StreamMeta, url: URL): Promise<Response> {
    const offsetParam = url.searchParams.get("offset");
    if (!offsetParam) return errorResponse(400, "offset is required");

    const resolved = this.resolveOffset(meta, offsetParam);
    if (resolved.error) return resolved.error;

    const offset = resolved.offset;
    const contentType = meta.content_type;
    const useBase64 = !isTextual(contentType);

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    const clientId = this.sseClientId++;
    const client: SseClient = {
      id: clientId,
      writer,
      offset,
      contentType,
      useBase64,
      closed: false,
      cursor: url.searchParams.get("cursor") ?? "",
    };

    this.sseClients.set(clientId, client);

    client.closeTimer = setTimeout(async () => {
      if (client.closed) return;
      await this.closeSseClient(client);
    }, SSE_RECONNECT_MS) as unknown as number;

    const headers = baseHeaders({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(meta.tail_offset),
    });

    if (useBase64) headers.set(HEADER_SSE_DATA_ENCODING, "base64");

    this.state.waitUntil(
      (async () => {
        await Promise.resolve();
        await this.runSseSession(streamId, meta, client);
      })(),
    );

    return new Response(readable, { status: 200, headers });
  }

  private async handleHead(streamId: string): Promise<Response> {
    const meta = await this.getStream(streamId);
    if (!meta) return errorResponse(404, "stream not found");

    return buildHeadResponse(meta);
  }

  private async handleDelete(streamId: string): Promise<Response> {
    return this.state.blockConcurrencyWhile(async () => {
      const meta = await this.getStream(streamId);
      if (!meta) return errorResponse(404, "stream not found");

      await this.deleteStreamData(streamId);

      return new Response(null, { status: 204, headers: baseHeaders() });
    });
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

  private resolveOffset(
    meta: StreamMeta,
    offsetParam: string | null,
  ): { offset: number; isNow: boolean; error?: Response } {
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

  private async broadcastSse(
    contentType: string,
    payload: ArrayBuffer | null,
    nextOffset: number,
    streamClosed: boolean,
  ): Promise<void> {
    if (!payload) return;

    const entries = Array.from(this.sseClients.values());
    for (const client of entries) {
      if (client.closed) continue;
      await this.writeSseData(client, payload, nextOffset, true, streamClosed);
      client.offset = nextOffset;
      if (streamClosed) {
        await this.closeSseClient(client);
      }
    }
  }

  private async broadcastSseControl(nextOffset: number, streamClosed: boolean): Promise<void> {
    const entries = Array.from(this.sseClients.values());
    for (const client of entries) {
      if (client.closed) continue;
      await this.writeSseControl(client, nextOffset, true, streamClosed);
      client.offset = nextOffset;
      if (streamClosed) {
        await this.closeSseClient(client);
      }
    }
  }

  private async runSseSession(
    streamId: string,
    meta: StreamMeta,
    client: SseClient,
  ): Promise<void> {
    try {
      let currentOffset = client.offset;
      let read = await readFromOffset(this.storage, streamId, meta, currentOffset, MAX_CHUNK_BYTES);
      if (read.error) {
        await this.closeSseClient(client);
        return;
      }

      if (read.hasData) {
        await this.writeSseData(
          client,
          read.body,
          read.nextOffset,
          read.upToDate,
          read.closedAtTail,
        );
        currentOffset = read.nextOffset;
        client.offset = currentOffset;

        while (!read.upToDate && !read.closedAtTail) {
          read = await readFromOffset(this.storage, streamId, meta, currentOffset, MAX_CHUNK_BYTES);
          if (read.error) break;
          if (!read.hasData) break;
          await this.writeSseData(
            client,
            read.body,
            read.nextOffset,
            read.upToDate,
            read.closedAtTail,
          );
          currentOffset = read.nextOffset;
          client.offset = currentOffset;
        }
      } else {
        await this.writeSseControl(
          client,
          currentOffset,
          true,
          meta.closed === 1 && currentOffset >= meta.tail_offset,
        );
      }

      if (meta.closed === 1 && currentOffset >= meta.tail_offset) {
        await this.closeSseClient(client);
      }
    } catch {
      await this.closeSseClient(client);
    }
  }

  private async closeSseClient(client: SseClient): Promise<void> {
    if (client.closed) return;
    client.closed = true;
    if (client.closeTimer) clearTimeout(client.closeTimer);
    try {
      await client.writer.close();
    } finally {
      this.sseClients.delete(client.id);
    }
  }

  private async snapshotToR2(
    streamId: string,
    contentType: string,
    endOffset: number,
  ): Promise<void> {
    if (!this.env.R2) return;
    const chunks = await this.storage.selectAllOps(streamId);
    const body = concatBuffers(chunks.map((chunk) => toUint8Array(chunk.body)));

    const key = `stream/${encodeURIComponent(streamId)}/snapshot-${Date.now()}`;
    await this.env.R2.put(key, body);

    await this.storage.insertSnapshot({
      streamId,
      r2Key: key,
      startOffset: 0,
      endOffset,
      contentType,
      createdAt: Date.now(),
    });
  }

  private async writeSseData(
    client: SseClient,
    payload: ArrayBuffer,
    nextOffset: number,
    upToDate: boolean,
    streamClosed: boolean,
  ): Promise<void> {
    const encoder = new TextEncoder();
    const dataEvent = buildSseDataEvent(payload, client.useBase64);
    const control = buildSseControlEvent({
      nextOffset,
      upToDate,
      streamClosed,
      cursor: client.cursor,
    });
    if (control.nextCursor) client.cursor = control.nextCursor;
    await client.writer.write(encoder.encode(dataEvent + control.payload));
  }

  private async writeSseControl(
    client: SseClient,
    nextOffset: number,
    upToDate: boolean,
    streamClosed: boolean,
  ): Promise<void> {
    const encoder = new TextEncoder();
    const control = buildSseControlEvent({
      nextOffset,
      upToDate,
      streamClosed,
      cursor: client.cursor,
    });
    if (control.nextCursor) client.cursor = control.nextCursor;
    await client.writer.write(encoder.encode(control.payload));
  }
}
