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

type ReadChunk = {
  start_offset: number;
  end_offset: number;
  size_bytes: number;
  body: ArrayBuffer;
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

const MAX_CHUNK_BYTES = 256 * 1024;
const OFFSET_WIDTH = 16;
const SSE_RECONNECT_MS = 55_000;

const CURSOR_EPOCH_MS = Date.UTC(2024, 9, 9, 0, 0, 0, 0);
const CURSOR_INTERVAL_SECONDS = 20;
const MIN_JITTER_SECONDS = 1;
const MAX_JITTER_SECONDS = 3600;

const HEADER_STREAM_NEXT_OFFSET = "Stream-Next-Offset";
const HEADER_STREAM_UP_TO_DATE = "Stream-Up-To-Date";
const HEADER_STREAM_CLOSED = "Stream-Closed";
const HEADER_STREAM_CURSOR = "Stream-Cursor";
const HEADER_STREAM_SEQ = "Stream-Seq";
const HEADER_STREAM_TTL = "Stream-TTL";
const HEADER_STREAM_EXPIRES_AT = "Stream-Expires-At";
const HEADER_PRODUCER_ID = "Producer-Id";
const HEADER_PRODUCER_EPOCH = "Producer-Epoch";
const HEADER_PRODUCER_SEQ = "Producer-Seq";
const HEADER_PRODUCER_EXPECTED_SEQ = "Producer-Expected-Seq";
const HEADER_PRODUCER_RECEIVED_SEQ = "Producer-Received-Seq";
const HEADER_SSE_DATA_ENCODING = "stream-sse-data-encoding";

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

      const headers = this.baseHeaders({
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

    const headers = this.baseHeaders({
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
  }

  private async handlePost(streamId: string, request: Request): Promise<Response> {
    const meta = await this.getStream(streamId);
    if (!meta) return this.err(404, "stream not found");

    const contentType = normalizeContentType(request.headers.get("Content-Type"));
    const closeStream = request.headers.get(HEADER_STREAM_CLOSED) === "true";

    const bodyBytes = new Uint8Array(await request.arrayBuffer());

    if (bodyBytes.length === 0 && closeStream) {
      if (!meta.closed) {
        await this.env.DB.prepare(
          "UPDATE streams SET closed = 1, closed_at = ? WHERE stream_id = ?",
        )
          .bind(Date.now(), streamId)
          .run();
      }

      const headers = this.baseHeaders({
        [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(meta.tail_offset),
        [HEADER_STREAM_CLOSED]: "true",
      });
      this.notifyWaiters(meta.tail_offset);
      await this.broadcastSseControl(meta.tail_offset, true);
      this.state.waitUntil(this.snapshotToR2(streamId, meta.content_type, meta.tail_offset));
      return new Response(null, { status: 204, headers });
    }

    if (!contentType) {
      return this.err(400, "Content-Type is required");
    }

    if (normalizeContentType(meta.content_type) !== contentType) {
      return this.err(409, "content-type mismatch");
    }

    if (meta.closed) {
      return this.err(409, "stream is closed");
    }

    const producer = this.parseProducerHeaders(request);
    if (producer && producer.error) return producer.error;

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

    const headers = this.baseHeaders({
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

    return new Response(null, { status: 204, headers });
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
      const headers = this.baseHeaders({
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

    const headers = this.baseHeaders({
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
      const headers = this.baseHeaders({
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
      const headers = this.baseHeaders({
        "Content-Type": meta.content_type,
        [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(initialRead.nextOffset),
        [HEADER_STREAM_CURSOR]: generateResponseCursor(url.searchParams.get("cursor") ?? ""),
      });
      if (initialRead.upToDate) headers.set(HEADER_STREAM_UP_TO_DATE, "true");
      if (initialRead.closedAtTail) headers.set(HEADER_STREAM_CLOSED, "true");
      applyExpiryHeaders(headers, meta);
      return new Response(initialRead.body, { status: 200, headers });
    }

    const timedOut = await this.waitForData(offset, 20_000);
    const current = await this.getStream(streamId);
    if (!current) return this.err(404, "stream not found");

    if (timedOut) {
      const headers = this.baseHeaders({
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

    const headers = this.baseHeaders({
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
      client.closed = true;
      try {
        await client.writer.close();
      } finally {
        this.sseClients.delete(client.id);
      }
    }, SSE_RECONNECT_MS) as unknown as number;

    let currentOffset = offset;
    let read = await this.readFromOffset(streamId, meta, currentOffset);
    if (read.error) {
      if (client.closeTimer) clearTimeout(client.closeTimer);
      this.sseClients.delete(clientId);
      await writer.close();
      return this.err(500, "read failed");
    }

    if (read.hasData) {
      await this.writeSseData(client, read.body, read.nextOffset, read.upToDate, read.closedAtTail);
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
      if (client.closeTimer) clearTimeout(client.closeTimer);
      await writer.close();
      this.sseClients.delete(clientId);
    }

    const headers = this.baseHeaders({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    if (useBase64) headers.set(HEADER_SSE_DATA_ENCODING, "base64");

    return new Response(readable, { status: 200, headers });
  }

  private async handleHead(streamId: string): Promise<Response> {
    const meta = await this.getStream(streamId);
    if (!meta) return this.err(404, "stream not found");

    const headers = this.baseHeaders({
      "Content-Type": meta.content_type,
      [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(meta.tail_offset),
      "Cache-Control": "no-store",
    });

    if (meta.closed === 1) headers.set(HEADER_STREAM_CLOSED, "true");
    applyExpiryHeaders(headers, meta);

    return new Response(null, { status: 200, headers });
  }

  private async handleDelete(streamId: string): Promise<Response> {
    await this.deleteStreamData(streamId);

    return new Response(null, { status: 204, headers: this.baseHeaders() });
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
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return {
          statements: [],
          newTailOffset: 0,
          ssePayload: null,
          error: this.err(400, "invalid JSON"),
        };
      }

      if (Array.isArray(value)) {
        if (value.length === 0) {
          return {
            statements: [],
            newTailOffset: 0,
            ssePayload: null,
            error: this.err(400, "empty JSON array is not allowed"),
          };
        }
        messages = value.map((item) => {
          const serialized = JSON.stringify(item);
          const encoded = new TextEncoder().encode(serialized);
          return { body: encoded.buffer, sizeBytes: encoded.byteLength };
        });
      } else {
        const serialized = JSON.stringify(value);
        const encoded = new TextEncoder().encode(serialized);
        messages = [{ body: encoded.buffer, sizeBytes: encoded.byteLength }];
      }
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

    if (opts.producer) {
      const producer = await this.getProducer(streamId, opts.producer.id);
      if (producer) {
        if (opts.producer.epoch < producer.epoch) {
          const res = this.err(403, "stale producer epoch");
          res.headers.set(HEADER_PRODUCER_EPOCH, producer.epoch.toString());
          return { statements: [], newTailOffset: 0, ssePayload: null, error: res };
        }

        if (opts.producer.epoch === producer.epoch) {
          if (opts.producer.seq === producer.last_seq) {
            const res = this.baseHeaders({
              [HEADER_STREAM_NEXT_OFFSET]: encodeOffset(producer.last_offset),
              [HEADER_PRODUCER_EPOCH]: producer.epoch.toString(),
              [HEADER_PRODUCER_SEQ]: producer.last_seq.toString(),
            });
            return {
              statements: [],
              newTailOffset: producer.last_offset,
              ssePayload: null,
              error: new Response(null, { status: 204, headers: res }),
            };
          }

          if (opts.producer.seq !== producer.last_seq + 1) {
            const res = this.err(409, "producer sequence gap");
            res.headers.set(HEADER_PRODUCER_EXPECTED_SEQ, (producer.last_seq + 1).toString());
            res.headers.set(HEADER_PRODUCER_RECEIVED_SEQ, opts.producer.seq.toString());
            return { statements: [], newTailOffset: 0, ssePayload: null, error: res };
          }
        }
      }
    }

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
      statements.push(
        this.env.DB.prepare(
          "INSERT INTO producers (stream_id, producer_id, epoch, last_seq, last_offset) VALUES (?, ?, ?, ?, ?) ON CONFLICT(stream_id, producer_id) DO UPDATE SET epoch = excluded.epoch, last_seq = excluded.last_seq, last_offset = excluded.last_offset",
        ).bind(streamId, opts.producer.id, opts.producer.epoch, opts.producer.seq, tailOffset),
      );
    }

    const ssePayload = messages.length === 1 ? messages[0].body : this.buildJsonArray(messages);

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

  private resolveOffset(
    meta: StreamMeta,
    offsetParam: string | null,
  ): { offset: number; isNow: boolean; error?: Response } {
    if (!offsetParam || offsetParam === "-1") {
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
        const source = new Uint8Array(overlap.body);
        const slice = source.slice(sliceStart);
        chunks.push({
          start_offset: offset,
          end_offset: overlap.end_offset,
          size_bytes: slice.byteLength,
          body: slice.buffer,
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
      chunks.push(row);
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
      body = concatBuffers(chunks.map((chunk) => new Uint8Array(chunk.body)));
    }

    return { body, nextOffset, upToDate, closedAtTail, hasData: true };
  }

  private buildJsonArray(messages: Array<{ body: ArrayBuffer; sizeBytes: number }>): ArrayBuffer {
    const decoder = new TextDecoder();
    const parts = messages.map((msg) => decoder.decode(msg.body));
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
        client.closed = true;
        if (client.closeTimer) clearTimeout(client.closeTimer);
        await client.writer.close();
        this.sseClients.delete(client.id);
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
        client.closed = true;
        if (client.closeTimer) clearTimeout(client.closeTimer);
        await client.writer.close();
        this.sseClients.delete(client.id);
      }
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
      body = concatBuffers(chunks.map((chunk) => new Uint8Array(chunk.body)));
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
    await client.writer.write(encoder.encode("event: data\n"));

    if (client.useBase64) {
      const encoded = btoa(String.fromCharCode(...new Uint8Array(payload)));
      await client.writer.write(encoder.encode(`data:${encoded}\n\n`));
    } else {
      const text = new TextDecoder().decode(payload);
      const lines = text.split(/\r\n|\n|\r/);
      for (const line of lines) {
        await client.writer.write(encoder.encode(`data:${line}\n`));
      }
      await client.writer.write(encoder.encode("\n"));
    }

    await this.writeSseControl(client, nextOffset, upToDate, streamClosed);
  }

  private async writeSseControl(
    client: SseClient,
    nextOffset: number,
    upToDate: boolean,
    streamClosed: boolean,
  ): Promise<void> {
    const encoder = new TextEncoder();
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

    await client.writer.write(encoder.encode("event: control\n"));
    await client.writer.write(encoder.encode(`data:${JSON.stringify(control)}\n\n`));
  }

  private baseHeaders(extra: Record<string, string> = {}): Headers {
    const headers = new Headers(extra);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
    return headers;
  }

  private err(status: number, message: string): Response {
    const headers = this.baseHeaders({ "Cache-Control": "no-store" });
    return new Response(message, { status, headers });
  }
}

function parseTtlSeconds(value: string | null): { value: number | null; error?: string } {
  if (!value) return { value: null };
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    return { value: null, error: "invalid Stream-TTL" };
  }
  return { value: parseInt(value, 10) };
}

function parseExpiresAt(value: string | null): { value: number | null; error?: string } {
  if (!value) return { value: null };
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return { value: null, error: "invalid Stream-Expires-At" };
  }
  return { value: parsed };
}

function ttlMatches(
  meta: StreamMeta,
  ttlSeconds: number | null,
  expiresAt: number | null,
): boolean {
  if (meta.ttl_seconds !== null) {
    return ttlSeconds !== null && meta.ttl_seconds === ttlSeconds;
  }
  if (meta.expires_at !== null) {
    return expiresAt !== null && meta.expires_at === expiresAt;
  }
  return ttlSeconds === null && expiresAt === null;
}

function applyExpiryHeaders(headers: Headers, meta: StreamMeta): void {
  if (meta.ttl_seconds !== null) {
    const remaining = remainingTtlSeconds(meta);
    if (remaining !== null) headers.set(HEADER_STREAM_TTL, remaining.toString());
  }
  if (meta.expires_at !== null) {
    headers.set(HEADER_STREAM_EXPIRES_AT, new Date(meta.expires_at).toISOString());
  }
}

function remainingTtlSeconds(meta: StreamMeta): number | null {
  if (meta.expires_at === null) return meta.ttl_seconds;
  const remainingMs = meta.expires_at - Date.now();
  return Math.max(0, Math.floor(remainingMs / 1000));
}

function cacheControlFor(meta: StreamMeta): string {
  const remaining = remainingTtlSeconds(meta);
  if (remaining === null) return "public, max-age=60, stale-while-revalidate=300";
  const maxAge = Math.min(60, Math.max(0, remaining));
  return `public, max-age=${maxAge}, stale-while-revalidate=300`;
}

function isExpired(meta: StreamMeta): boolean {
  if (meta.expires_at === null) return false;
  return Date.now() >= meta.expires_at;
}

function normalizeContentType(value: string | null): string | null {
  if (!value) return null;
  return value.split(";")[0]?.trim().toLowerCase() ?? null;
}

function isJsonContentType(value: string): boolean {
  return normalizeContentType(value) === "application/json";
}

function isTextual(value: string): boolean {
  const normalized = normalizeContentType(value);
  return normalized?.startsWith("text/") || normalized === "application/json";
}

function isInteger(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value);
}

function encodeOffset(offset: number): string {
  if (offset < 0) return "0".repeat(OFFSET_WIDTH);
  return offset.toString(16).toUpperCase().padStart(OFFSET_WIDTH, "0");
}

function decodeOffset(token: string): number | null {
  if (!/^[0-9a-fA-F]+$/.test(token)) return null;
  const parsed = parseInt(token, 16);
  if (Number.isNaN(parsed)) return null;
  return parsed;
}

function buildEtag(streamId: string, start: number, end: number, closed: boolean): string {
  return `"${streamId}:${start}:${end}${closed ? ":c" : ""}"`;
}

function generateCursor(): string {
  const now = Date.now();
  const intervalMs = CURSOR_INTERVAL_SECONDS * 1000;
  const intervalNumber = Math.floor((now - CURSOR_EPOCH_MS) / intervalMs);
  return intervalNumber.toString(10);
}

function generateResponseCursor(clientCursor: string): string {
  const current = generateCursor();
  const currentInterval = parseInt(current, 10);

  if (!clientCursor) return current;

  const clientInterval = parseInt(clientCursor, 10);
  if (!Number.isFinite(clientInterval) || clientInterval < currentInterval) {
    return current;
  }

  const jitterSeconds = Math.floor((MIN_JITTER_SECONDS + MAX_JITTER_SECONDS) / 2);
  const jitterIntervals = Math.max(1, Math.floor(jitterSeconds / CURSOR_INTERVAL_SECONDS));
  return (clientInterval + jitterIntervals).toString(10);
}

function concatBuffers(chunks: Uint8Array[]): ArrayBuffer {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}
