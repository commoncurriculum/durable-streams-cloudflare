import {
  HEADER_PRODUCER_EPOCH,
  HEADER_PRODUCER_EXPECTED_SEQ,
  HEADER_PRODUCER_ID,
  HEADER_PRODUCER_RECEIVED_SEQ,
  HEADER_PRODUCER_SEQ,
  HEADER_SSE_DATA_ENCODING,
  HEADER_STREAM_CLOSED,
  HEADER_STREAM_CURSOR,
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
} from "./protocol/constants";
import {
  applyExpiryHeaders,
  cacheControlFor,
  isExpired,
  parseExpiresAt,
  parseTtlSeconds,
  ttlMatches,
} from "./protocol/expiry";
import { buildEtag } from "./protocol/etag";
import { generateResponseCursor } from "./protocol/cursor";
import { base64Encode, concatBuffers, toUint8Array } from "./protocol/encoding";
import { decodeOffset, encodeOffset } from "./protocol/offsets";
import { isInteger } from "./protocol/validation";

type StreamMeta = {
  stream_id: string;
  content_type: string;
  closed: number;
  tail_offset: number;
  last_stream_seq: string | null;
  ttl_seconds: number | null;
  expires_at: number | null;
  created_at: number;
  closed_at: number | null;
};

type ProducerState = {
  producer_id: string;
  epoch: number;
  last_seq: number;
  last_offset: number;
};

type ProducerEval =
  | { kind: "none" }
  | { kind: "ok"; state: ProducerState | null }
  | { kind: "duplicate"; state: ProducerState }
  | { kind: "error"; response: Response };

type ReadChunk = {
  start_offset: number;
  end_offset: number;
  size_bytes: number;
  body: ArrayBuffer | Uint8Array | string | number[];
};

type Waiter = {
  offset: number;
  resolve: (result: { timedOut: boolean }) => void;
  timer: number;
};

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
  private waiters: Waiter[] = [];
  private sseClients: Map<number, SseClient> = new Map();
  private sseClientId = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const streamId = request.headers.get("X-Stream-Id");
    if (!streamId) {
      return this.err(400, "missing stream id");
    }

    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    try {
      if (method === "PUT") return await this.handlePut(streamId, request);
      if (method === "POST") return await this.handlePost(streamId, request);
      if (method === "GET") return await this.handleGet(streamId, request, url);
      if (method === "HEAD") return await this.handleHead(streamId);
      if (method === "DELETE") return await this.handleDelete(streamId);
      return this.err(405, "method not allowed");
    } catch (e) {
      return this.err(500, e instanceof Error ? e.message : "internal error");
    }
  }

  private async handlePut(streamId: string, request: Request): Promise<Response> {
    return this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const headerContentType = normalizeContentType(request.headers.get("Content-Type"));
      const requestedClosed = request.headers.get(HEADER_STREAM_CLOSED) === "true";
      const ttlHeader = request.headers.get(HEADER_STREAM_TTL);
      const expiresHeader = request.headers.get(HEADER_STREAM_EXPIRES_AT);

      if (ttlHeader && expiresHeader) {
        return this.err(400, "Stream-TTL and Stream-Expires-At are mutually exclusive");
      }

      const ttlSeconds = parseTtlSeconds(ttlHeader);
      if (ttlSeconds.error) return this.err(400, ttlSeconds.error);

      const expiresAt = parseExpiresAt(expiresHeader);
      if (expiresAt.error) return this.err(400, expiresAt.error);

      const effectiveExpiresAt =
        ttlSeconds.value !== null ? now + ttlSeconds.value * 1000 : expiresAt.value;

      let bodyBytes = new Uint8Array(await request.arrayBuffer());
      if (bodyBytes.length > MAX_APPEND_BYTES) {
        return this.err(413, "payload too large");
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
          return this.err(409, "content-type mismatch");
        }
        if (requestedClosed !== (existing.closed === 1)) {
          return this.err(409, "stream closed status mismatch");
        }
        if (!ttlMatches(existing, ttlSeconds.value, effectiveExpiresAt)) {
          return this.err(409, "stream TTL/expiry mismatch");
        }

        const headers = baseHeaders({
          "Content-Type": existing.content_type,
          [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(existing.tail_offset),
        });
        applyExpiryHeaders(headers, existing);
        if (existing.closed === 1) headers.set(HEADER_STREAM_CLOSED, "true");
        return new Response(null, { status: 200, headers });
      }

      const contentType = headerContentType ?? "application/octet-stream";

      await this.env.DB.prepare(
        "INSERT INTO streams (stream_id, content_type, closed, tail_offset, last_stream_seq, ttl_seconds, expires_at, created_at) VALUES (?, ?, ?, 0, NULL, ?, ?, ?)",
      )
        .bind(
          streamId,
          contentType,
          requestedClosed ? 1 : 0,
          ttlSeconds.value,
          effectiveExpiresAt,
          now,
        )
        .run();

      let tailOffset = 0;

      const producer = this.parseProducerHeaders(request);
      if (producer && producer.error) return producer.error;

      if (producer?.value) {
        const producerEval = await this.evaluateProducer(streamId, producer.value);
        if (producerEval.kind === "error") return producerEval.response;
      }

      if (bodyBytes.length > 0) {
        const append = await this.buildAppendBatch(streamId, contentType, bodyBytes, {
          streamSeq: request.headers.get(HEADER_STREAM_SEQ),
          producer: producer?.value ?? null,
          closeStream: requestedClosed,
        });

        if (append.error) return append.error;
        await this.env.DB.batch(append.statements);
        tailOffset = append.newTailOffset;
      }

      const headers = baseHeaders({
        "Content-Type": contentType,
        [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(tailOffset),
      });
      applyExpiryHeaders(headers, {
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
      if (requestedClosed) headers.set(HEADER_STREAM_CLOSED, "true");
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
      if (!meta) return this.err(404, "stream not found");

      const closeStream = request.headers.get(HEADER_STREAM_CLOSED) === "true";

      const bodyBytes = new Uint8Array(await request.arrayBuffer());
      if (bodyBytes.length > MAX_APPEND_BYTES) {
        return this.err(413, "payload too large");
      }

      const producer = this.parseProducerHeaders(request);
      if (producer && producer.error) return producer.error;

      let producerEval: ProducerEval = { kind: "none" };
      if (producer?.value) {
        producerEval = await this.evaluateProducer(streamId, producer.value);
        if (producerEval.kind === "error") return producerEval.response;
        if (producerEval.kind === "duplicate") {
          return this.producerDuplicateResponse(producerEval.state, meta.closed === 1);
        }
      }

      if (bodyBytes.length === 0 && closeStream) {
        if (meta.closed === 1 && producer?.value) {
          return this.closedConflict(meta);
        }

        if (!meta.closed) {
          await this.env.DB.prepare(
            "UPDATE streams SET closed = 1, closed_at = ? WHERE stream_id = ?",
          )
            .bind(Date.now(), streamId)
            .run();
        }

        if (producer?.value) {
          await this.producerUpsertStatement(streamId, producer.value, meta.tail_offset).run();
        }

        const headers = baseHeaders({
          [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(meta.tail_offset),
          [HEADER_STREAM_CLOSED]: "true",
        });

        if (producer?.value) {
          headers.set(HEADER_PRODUCER_EPOCH, producer.value.epoch.toString());
          headers.set(HEADER_PRODUCER_SEQ, producer.value.seq.toString());
        }

        this.notifyWaiters(meta.tail_offset);
        await this.broadcastSseControl(meta.tail_offset, true);
        this.state.waitUntil(this.snapshotToR2(streamId, meta.content_type, meta.tail_offset));
        return new Response(null, { status: 204, headers });
      }

      if (bodyBytes.length === 0) {
        return this.err(400, "empty body");
      }

      if (meta.closed === 1) {
        return this.closedConflict(meta);
      }

      const contentType = normalizeContentType(request.headers.get("Content-Type"));
      if (!contentType) {
        return this.err(400, "Content-Type is required");
      }

      if (normalizeContentType(meta.content_type) !== contentType) {
        return this.err(409, "content-type mismatch");
      }

      const streamSeq = request.headers.get(HEADER_STREAM_SEQ);
      if (streamSeq && meta.last_stream_seq && streamSeq <= meta.last_stream_seq) {
        return this.err(409, "Stream-Seq regression");
      }

      const append = await this.buildAppendBatch(streamId, contentType, bodyBytes, {
        streamSeq,
        producer: producer?.value ?? null,
        closeStream,
      });

      if (append.error) return append.error;

      await this.env.DB.batch(append.statements);

      const headers = baseHeaders({
        [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(append.newTailOffset),
      });

      if (producer?.value) {
        headers.set(HEADER_PRODUCER_EPOCH, producer.value.epoch.toString());
        headers.set(HEADER_PRODUCER_SEQ, producer.value.seq.toString());
      }

      if (closeStream) headers.set(HEADER_STREAM_CLOSED, "true");

      this.notifyWaiters(append.newTailOffset);
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
    if (!meta) return this.err(404, "stream not found");

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
      const headers = baseHeaders({
        "Content-Type": meta.content_type,
        [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(meta.tail_offset),
      });
      headers.set("Cache-Control", "no-store");
      headers.set(HEADER_STREAM_UP_TO_DATE, "true");
      if (meta.closed === 1) headers.set(HEADER_STREAM_CLOSED, "true");
      applyExpiryHeaders(headers, meta);
      const body = isJsonContentType(meta.content_type) ? new TextEncoder().encode("[]") : null;
      return new Response(body, { status: 200, headers });
    }

    const read = await this.readFromOffset(streamId, meta, offset);
    if (read.error) return read.error;

    const headers = baseHeaders({
      "Content-Type": meta.content_type,
      [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(read.nextOffset),
    });

    if (read.upToDate) headers.set(HEADER_STREAM_UP_TO_DATE, "true");
    if (read.closedAtTail) headers.set(HEADER_STREAM_CLOSED, "true");
    applyExpiryHeaders(headers, meta);

    const etag = buildEtag(streamId, offset, read.nextOffset, meta.closed === 1);
    headers.set("ETag", etag);

    const ifNoneMatch = request.headers.get("If-None-Match");
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers });
    }

    headers.set("Cache-Control", cacheControlFor(meta));
    return new Response(read.body, { status: 200, headers });
  }

  private async handleLongPoll(streamId: string, meta: StreamMeta, url: URL): Promise<Response> {
    const offsetParam = url.searchParams.get("offset");
    if (!offsetParam) return this.err(400, "offset is required");

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

    const initialRead = await this.readFromOffset(streamId, meta, offset);
    if (initialRead.error) return initialRead.error;

    if (initialRead.hasData) {
      const headers = baseHeaders({
        "Content-Type": meta.content_type,
        [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(initialRead.nextOffset),
        [HEADER_STREAM_CURSOR]: generateResponseCursor(url.searchParams.get("cursor") ?? ""),
      });
      if (initialRead.upToDate) headers.set(HEADER_STREAM_UP_TO_DATE, "true");
      if (initialRead.closedAtTail) headers.set(HEADER_STREAM_CLOSED, "true");
      applyExpiryHeaders(headers, meta);
      return new Response(initialRead.body, { status: 200, headers });
    }

    const timedOut = await this.waitForData(offset, LONG_POLL_TIMEOUT_MS);
    const current = await this.getStream(streamId);
    if (!current) return this.err(404, "stream not found");

    if (timedOut) {
      const headers = baseHeaders({
        [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(current.tail_offset),
        [HEADER_STREAM_UP_TO_DATE]: "true",
        [HEADER_STREAM_CURSOR]: generateResponseCursor(url.searchParams.get("cursor") ?? ""),
      });

      if (current.closed === 1 && current.tail_offset === offset) {
        headers.set(HEADER_STREAM_CLOSED, "true");
      }
      headers.set("Cache-Control", "no-store");
      applyExpiryHeaders(headers, current);
      return new Response(null, { status: 204, headers });
    }

    const read = await this.readFromOffset(streamId, current, offset);
    if (read.error) return read.error;

    const headers = baseHeaders({
      "Content-Type": current.content_type,
      [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(read.nextOffset),
      [HEADER_STREAM_CURSOR]: generateResponseCursor(url.searchParams.get("cursor") ?? ""),
    });

    if (read.upToDate) headers.set(HEADER_STREAM_UP_TO_DATE, "true");
    if (read.closedAtTail) headers.set(HEADER_STREAM_CLOSED, "true");
    applyExpiryHeaders(headers, current);

    if (!read.hasData) {
      headers.set("Cache-Control", "no-store");
      return new Response(null, { status: 204, headers });
    }

    return new Response(read.body, { status: 200, headers });
  }

  private async handleSse(streamId: string, meta: StreamMeta, url: URL): Promise<Response> {
    const offsetParam = url.searchParams.get("offset");
    if (!offsetParam) return this.err(400, "offset is required");

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
    if (!meta) return this.err(404, "stream not found");

    const headers = baseHeaders({
      "Content-Type": meta.content_type,
      [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(meta.tail_offset),
      "Cache-Control": "no-store",
    });

    if (meta.closed === 1) headers.set(HEADER_STREAM_CLOSED, "true");
    applyExpiryHeaders(headers, meta);

    return new Response(null, { status: 200, headers });
  }

  private async handleDelete(streamId: string): Promise<Response> {
    return this.state.blockConcurrencyWhile(async () => {
      const meta = await this.getStream(streamId);
      if (!meta) return this.err(404, "stream not found");

      await this.deleteStreamData(streamId);

      return new Response(null, { status: 204, headers: baseHeaders() });
    });
  }

  private async getStream(streamId: string): Promise<StreamMeta | null> {
    const result = await this.env.DB.prepare("SELECT * FROM streams WHERE stream_id = ?")
      .bind(streamId)
      .first<StreamMeta>();

    if (!result) return null;
    if (isExpired(result)) {
      await this.deleteStreamData(streamId);
      return null;
    }

    return result;
  }

  private async deleteStreamData(streamId: string): Promise<void> {
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM snapshots WHERE stream_id = ?").bind(streamId),
      this.env.DB.prepare("DELETE FROM ops WHERE stream_id = ?").bind(streamId),
      this.env.DB.prepare("DELETE FROM producers WHERE stream_id = ?").bind(streamId),
      this.env.DB.prepare("DELETE FROM streams WHERE stream_id = ?").bind(streamId),
    ]);
  }

  private parseProducerHeaders(
    request: Request,
  ): { value?: { id: string; epoch: number; seq: number }; error?: Response } | null {
    const id = request.headers.get(HEADER_PRODUCER_ID);
    const epochStr = request.headers.get(HEADER_PRODUCER_EPOCH);
    const seqStr = request.headers.get(HEADER_PRODUCER_SEQ);

    const any = id || epochStr || seqStr;
    if (!any) return null;

    if (!id || !epochStr || !seqStr) {
      return { error: this.err(400, "Producer headers must be provided together") };
    }

    if (id.trim().length === 0) {
      return { error: this.err(400, "Producer-Id must not be empty") };
    }

    if (!isInteger(epochStr) || !isInteger(seqStr)) {
      return { error: this.err(400, "Producer-Epoch and Producer-Seq must be integers") };
    }

    return { value: { id, epoch: parseInt(epochStr, 10), seq: parseInt(seqStr, 10) } };
  }

  private async buildAppendBatch(
    streamId: string,
    contentType: string,
    bodyBytes: Uint8Array,
    opts: {
      streamSeq: string | null;
      producer: { id: string; epoch: number; seq: number } | null;
      closeStream: boolean;
    },
  ): Promise<{
    statements: D1PreparedStatement[];
    newTailOffset: number;
    ssePayload: ArrayBuffer | null;
    error?: Response;
  }> {
    const meta = await this.getStream(streamId);
    if (!meta)
      return {
        statements: [],
        newTailOffset: 0,
        ssePayload: null,
        error: this.err(404, "stream not found"),
      };

    const statements: D1PreparedStatement[] = [];
    const now = Date.now();

    let messages: Array<{ body: ArrayBuffer; sizeBytes: number }> = [];

    if (isJsonContentType(contentType)) {
      const text = new TextDecoder().decode(bodyBytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          statements: [],
          newTailOffset: 0,
          ssePayload: null,
          error: this.err(400, "invalid JSON"),
        };
      }

      const values = Array.isArray(parsed) ? parsed : [parsed];
      if (values.length === 0) {
        return {
          statements: [],
          newTailOffset: 0,
          ssePayload: null,
          error: this.err(400, "empty JSON array is not allowed"),
        };
      }

      const encoder = new TextEncoder();
      messages = values.map((value) => {
        const serialized = JSON.stringify(value);
        const encoded = encoder.encode(serialized);
        return { body: encoded.buffer, sizeBytes: encoded.byteLength };
      });
    } else {
      if (bodyBytes.length === 0) {
        return {
          statements: [],
          newTailOffset: 0,
          ssePayload: null,
          error: this.err(400, "empty body"),
        };
      }
      messages = [{ body: bodyBytes.buffer, sizeBytes: bodyBytes.byteLength }];
    }

    let tailOffset = meta.tail_offset;

    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i];
      const messageStart = tailOffset;
      const messageEnd = isJsonContentType(contentType)
        ? messageStart + 1
        : messageStart + message.sizeBytes;

      statements.push(
        this.env.DB.prepare(
          "INSERT INTO ops (stream_id, start_offset, end_offset, size_bytes, stream_seq, producer_id, producer_epoch, producer_seq, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          streamId,
          messageStart,
          messageEnd,
          message.sizeBytes,
          opts.streamSeq ?? null,
          opts.producer?.id ?? null,
          opts.producer?.epoch ?? null,
          opts.producer?.seq ?? null,
          message.body,
          now,
        ),
      );

      tailOffset = messageEnd;
    }

    const updateFields: string[] = ["tail_offset = ?"];
    const updateValues: unknown[] = [tailOffset];

    if (opts.streamSeq) {
      updateFields.push("last_stream_seq = ?");
      updateValues.push(opts.streamSeq);
    }

    if (opts.closeStream) {
      updateFields.push("closed = 1", "closed_at = ?");
      updateValues.push(now);
    }

    updateValues.push(streamId);

    statements.push(
      this.env.DB.prepare(`UPDATE streams SET ${updateFields.join(", ")} WHERE stream_id = ?`).bind(
        ...updateValues,
      ),
    );

    if (opts.producer) {
      statements.push(this.producerUpsertStatement(streamId, opts.producer, tailOffset));
    }

    const ssePayload = isJsonContentType(contentType)
      ? this.buildJsonArray(messages)
      : messages.length === 1
        ? messages[0].body
        : concatBuffers(messages.map((msg) => toUint8Array(msg.body)));

    return { statements, newTailOffset: tailOffset, ssePayload };
  }

  private async getProducer(streamId: string, producerId: string): Promise<ProducerState | null> {
    const result = await this.env.DB.prepare(
      "SELECT * FROM producers WHERE stream_id = ? AND producer_id = ?",
    )
      .bind(streamId, producerId)
      .first<ProducerState>();

    return result ?? null;
  }

  private async evaluateProducer(
    streamId: string,
    producer: { id: string; epoch: number; seq: number },
  ): Promise<ProducerEval> {
    const existing = await this.getProducer(streamId, producer.id);
    if (!existing) {
      if (producer.seq !== 0) {
        return { kind: "error", response: this.err(400, "Producer-Seq must start at 0") };
      }
      return { kind: "ok", state: null };
    }

    if (producer.epoch < existing.epoch) {
      const res = this.err(403, "stale producer epoch");
      res.headers.set(HEADER_PRODUCER_EPOCH, existing.epoch.toString());
      return { kind: "error", response: res };
    }

    if (producer.epoch > existing.epoch) {
      if (producer.seq !== 0) {
        return {
          kind: "error",
          response: this.err(400, "Producer-Seq must start at 0 for new epoch"),
        };
      }
      return { kind: "ok", state: existing };
    }

    if (producer.seq <= existing.last_seq) {
      return { kind: "duplicate", state: existing };
    }

    if (producer.seq !== existing.last_seq + 1) {
      const res = this.err(409, "producer sequence gap");
      res.headers.set(HEADER_PRODUCER_EXPECTED_SEQ, (existing.last_seq + 1).toString());
      res.headers.set(HEADER_PRODUCER_RECEIVED_SEQ, producer.seq.toString());
      return { kind: "error", response: res };
    }

    return { kind: "ok", state: existing };
  }

  private producerDuplicateResponse(state: ProducerState, streamClosed: boolean): Response {
    const headers = baseHeaders({
      [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(state.last_offset),
      [HEADER_PRODUCER_EPOCH]: state.epoch.toString(),
      [HEADER_PRODUCER_SEQ]: state.last_seq.toString(),
    });

    if (streamClosed) headers.set(HEADER_STREAM_CLOSED, "true");

    return new Response(null, { status: 204, headers });
  }

  private closedConflict(meta: StreamMeta): Response {
    const headers = baseHeaders({
      [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(meta.tail_offset),
      [HEADER_STREAM_CLOSED]: "true",
    });
    return new Response("stream is closed", { status: 409, headers });
  }

  private producerUpsertStatement(
    streamId: string,
    producer: { id: string; epoch: number; seq: number },
    lastOffset: number,
  ): D1PreparedStatement {
    return this.env.DB.prepare(
      "INSERT INTO producers (stream_id, producer_id, epoch, last_seq, last_offset) VALUES (?, ?, ?, ?, ?) ON CONFLICT(stream_id, producer_id) DO UPDATE SET epoch = excluded.epoch, last_seq = excluded.last_seq, last_offset = excluded.last_offset",
    ).bind(streamId, producer.id, producer.epoch, producer.seq, lastOffset);
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
      return { offset: 0, isNow: false, error: this.err(400, "invalid offset") };
    }

    if (decoded > meta.tail_offset) {
      return { offset: 0, isNow: false, error: this.err(400, "offset beyond tail") };
    }

    return { offset: decoded, isNow: false };
  }

  private async readFromOffset(
    streamId: string,
    meta: StreamMeta,
    offset: number,
  ): Promise<{
    body: ArrayBuffer;
    nextOffset: number;
    upToDate: boolean;
    closedAtTail: boolean;
    hasData: boolean;
    error?: Response;
  }> {
    const chunks: ReadChunk[] = [];

    if (offset > 0) {
      const overlap = await this.env.DB.prepare(
        "SELECT start_offset, end_offset, size_bytes, body FROM ops WHERE stream_id = ? AND start_offset < ? AND end_offset > ? ORDER BY start_offset DESC LIMIT 1",
      )
        .bind(streamId, offset, offset)
        .first<ReadChunk>();

      if (overlap) {
        if (isJsonContentType(meta.content_type) && overlap.start_offset !== offset) {
          return {
            body: new ArrayBuffer(0),
            nextOffset: offset,
            upToDate: false,
            closedAtTail: false,
            hasData: false,
            error: this.err(400, "invalid offset"),
          };
        }
        const sliceStart = offset - overlap.start_offset;
        const source = toUint8Array(overlap.body);
        const slice = source.slice(sliceStart);
        chunks.push({
          start_offset: offset,
          end_offset: overlap.end_offset,
          size_bytes: slice.byteLength,
          body: slice,
        });
      }
    }

    const rows = await this.env.DB.prepare(
      "SELECT start_offset, end_offset, size_bytes, body FROM ops WHERE stream_id = ? AND start_offset >= ? ORDER BY start_offset ASC LIMIT 200",
    )
      .bind(streamId, offset)
      .all<ReadChunk>();
    let bytes = chunks.reduce((sum, chunk) => sum + chunk.size_bytes, 0);

    for (const row of rows.results ?? []) {
      if (bytes + row.size_bytes > MAX_CHUNK_BYTES && bytes > 0) break;
      const body = toUint8Array(row.body);
      chunks.push({
        start_offset: row.start_offset,
        end_offset: row.end_offset,
        size_bytes: row.size_bytes,
        body,
      });
      bytes += row.size_bytes;
      if (bytes >= MAX_CHUNK_BYTES) break;
    }

    if (chunks.length === 0) {
      const upToDate = offset === meta.tail_offset;
      const closedAtTail = meta.closed === 1 && upToDate;
      if (isJsonContentType(meta.content_type)) {
        const empty = new TextEncoder().encode("[]").buffer;
        return { body: empty, nextOffset: offset, upToDate, closedAtTail, hasData: false };
      }
      return {
        body: new ArrayBuffer(0),
        nextOffset: offset,
        upToDate,
        closedAtTail,
        hasData: false,
      };
    }

    const nextOffset = chunks[chunks.length - 1].end_offset;
    const upToDate = nextOffset === meta.tail_offset;
    const closedAtTail = meta.closed === 1 && upToDate;

    let body: ArrayBuffer;
    if (isJsonContentType(meta.content_type)) {
      body = this.buildJsonArray(
        chunks.map((chunk) => ({ body: chunk.body, sizeBytes: chunk.size_bytes })),
      );
    } else {
      body = concatBuffers(chunks.map((chunk) => toUint8Array(chunk.body)));
    }

    return { body, nextOffset, upToDate, closedAtTail, hasData: true };
  }

  private buildJsonArray(
    messages: Array<{ body: ArrayBuffer | Uint8Array | string | number[]; sizeBytes: number }>,
  ): ArrayBuffer {
    const decoder = new TextDecoder();
    const parts = messages.map((msg) => decoder.decode(toUint8Array(msg.body)));
    const joined = `[${parts.join(",")}]`;
    return new TextEncoder().encode(joined).buffer;
  }

  private async waitForData(offset: number, timeoutMs: number): Promise<boolean> {
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

  private notifyWaiters(newTail: number): void {
    const ready = this.waiters.filter((w) => newTail > w.offset);
    this.waiters = this.waiters.filter((w) => newTail <= w.offset);

    for (const waiter of ready) {
      clearTimeout(waiter.timer);
      waiter.resolve({ timedOut: false });
    }
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
      let read = await this.readFromOffset(streamId, meta, currentOffset);
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
          read = await this.readFromOffset(streamId, meta, currentOffset);
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
    const rows = await this.env.DB.prepare(
      "SELECT start_offset, end_offset, size_bytes, body FROM ops WHERE stream_id = ? ORDER BY start_offset ASC",
    )
      .bind(streamId)
      .all<ReadChunk>();

    const chunks = rows.results ?? [];
    let body: ArrayBuffer;
    if (isJsonContentType(contentType)) {
      body = this.buildJsonArray(
        chunks.map((chunk) => ({ body: chunk.body, sizeBytes: chunk.size_bytes })),
      );
    } else {
      body = concatBuffers(chunks.map((chunk) => toUint8Array(chunk.body)));
    }

    const key = `stream/${encodeURIComponent(streamId)}/snapshot-${Date.now()}`;
    await this.env.R2.put(key, body);

    await this.env.DB.prepare(
      "INSERT INTO snapshots (stream_id, r2_key, start_offset, end_offset, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(streamId, key, 0, endOffset, contentType, Date.now())
      .run();
  }

  private async writeSseData(
    client: SseClient,
    payload: ArrayBuffer,
    nextOffset: number,
    upToDate: boolean,
    streamClosed: boolean,
  ): Promise<void> {
    const encoder = new TextEncoder();
    let output = "event: data\n";

    if (client.useBase64) {
      const encoded = base64Encode(new Uint8Array(payload));
      output += `data:${encoded}\n\n`;
    } else {
      const text = new TextDecoder().decode(payload);
      const lines = text.split(/\r\n|\n|\r/);
      for (const line of lines) {
        output += `data:${line}\n`;
      }
      output += "\n";
    }

    output += this.buildSseControlEvent(client, nextOffset, upToDate, streamClosed);
    await client.writer.write(encoder.encode(output));
  }

  private buildSseControlEvent(
    client: SseClient,
    nextOffset: number,
    upToDate: boolean,
    streamClosed: boolean,
  ): string {
    const control: Record<string, unknown> = {
      streamNextOffset: encodeOffset(nextOffset),
    };

    if (streamClosed) {
      control.streamClosed = true;
    } else {
      const nextCursor = generateResponseCursor(client.cursor);
      client.cursor = nextCursor;
      control.streamCursor = nextCursor;
      if (upToDate) control.upToDate = true;
    }

    return `event: control\n` + `data:${JSON.stringify(control)}\n\n`;
  }

  private async writeSseControl(
    client: SseClient,
    nextOffset: number,
    upToDate: boolean,
    streamClosed: boolean,
  ): Promise<void> {
    const encoder = new TextEncoder();
    const payload = this.buildSseControlEvent(client, nextOffset, upToDate, streamClosed);
    await client.writer.write(encoder.encode(payload));
  }

  private err(status: number, message: string): Response {
    const headers = baseHeaders({ "Cache-Control": "no-store" });
    return new Response(message, { status, headers });
  }
}
