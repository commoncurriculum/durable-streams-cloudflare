import { base64Encode } from "../protocol/encoding";
import { isJsonContentType } from "../protocol/headers";
import type { StreamContext } from "../http/context";
import type { StreamMeta } from "../storage/storage";

const FANOUT_SUBSCRIBER_THRESHOLD = 0;
const SESSION_STREAM_PREFIX = "subscriptions/";

export type FanInEnvelope = {
  stream: string;
  offset: string;
  type: "data";
  payload: unknown;
  encoding?: "base64";
};

export type FanOutQueueMessage = {
  sessionId: string;
  envelope: FanInEnvelope;
};

export async function fanOutAppend(
  ctx: StreamContext,
  streamId: string,
  meta: StreamMeta,
  contentType: string,
  bodyBytes: Uint8Array,
  newTailOffset: number,
): Promise<void> {
  if (!ctx.env.STREAMS) return;
  if (streamId.startsWith(SESSION_STREAM_PREFIX)) return;
  if (!meta.subscriber_count || meta.subscriber_count <= 0) return;

  const offset = await ctx.encodeOffset(streamId, meta, newTailOffset);
  const envelope = buildEnvelope(streamId, offset, contentType, bodyBytes);

  const sessionIds = await ctx.storage.listStreamSubscribers(streamId);
  if (sessionIds.length === 0) return;

  if (meta.subscriber_count > FANOUT_SUBSCRIBER_THRESHOLD) {
    if (ctx.env.FANOUT_QUEUE) {
      await enqueueFanout(ctx.env.FANOUT_QUEUE, sessionIds, envelope);
      return;
    }
    ctx.state.waitUntil(deliverInline(ctx, sessionIds, envelope));
    return;
  }

  await deliverInline(ctx, sessionIds, envelope);
}

function buildEnvelope(
  streamId: string,
  offset: string,
  contentType: string,
  bodyBytes: Uint8Array,
): FanInEnvelope {
  if (isJsonContentType(contentType)) {
    const text = new TextDecoder().decode(bodyBytes);
    try {
      const payload = JSON.parse(text);
      return { stream: streamId, offset, type: "data", payload };
    } catch {
      const encoded = base64Encode(bodyBytes);
      return { stream: streamId, offset, type: "data", payload: encoded, encoding: "base64" };
    }
  }

  const encoded = base64Encode(bodyBytes);
  return { stream: streamId, offset, type: "data", payload: encoded, encoding: "base64" };
}

async function deliverInline(
  ctx: StreamContext,
  sessionIds: string[],
  envelope: FanInEnvelope,
): Promise<void> {
  if (!ctx.env.STREAMS) return;
  await Promise.all(
    sessionIds.map((sessionId) => appendEnvelopeToSession(ctx.env.STREAMS!, sessionId, envelope)),
  );
}

async function enqueueFanout(
  queue: Queue,
  sessionIds: string[],
  envelope: FanInEnvelope,
): Promise<void> {
  const batch: MessageSendRequest<FanOutQueueMessage>[] = [];
  const batchSize = 100;
  for (const sessionId of sessionIds) {
    batch.push({
      body: { sessionId, envelope },
      contentType: "json",
    });
    if (batch.length >= batchSize) {
      await queue.sendBatch(batch);
      batch.length = 0;
    }
  }
  if (batch.length > 0) {
    await queue.sendBatch(batch);
  }
}

export async function appendEnvelopeToSession(
  streams: DurableObjectNamespace,
  sessionId: string,
  envelope: FanInEnvelope,
): Promise<Response> {
  const sessionStreamId = `${SESSION_STREAM_PREFIX}${sessionId}`;
  const id = streams.idFromName(sessionStreamId);
  const stub = streams.get(id);
  const url = new URL("https://internal/internal/fan-in-append");
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Stream-Id": sessionStreamId,
  });
  const response = await stub.fetch(
    new Request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
    }),
  );
  if (!response.ok) await response.arrayBuffer();
  return response;
}
