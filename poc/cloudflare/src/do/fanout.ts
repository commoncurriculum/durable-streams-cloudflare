import { isJsonContentType } from "../protocol/headers";
import { base64Encode } from "../protocol/encoding";
import type { StreamContext } from "../http/context";
import type { StreamMeta } from "../storage/storage";

const FANOUT_SUBSCRIBER_THRESHOLD = 200;
const SESSION_STREAM_PREFIX = "subscriptions/";

type FanInEnvelope = {
  stream: string;
  offset: string;
  type: "data";
  payload: unknown;
  encoding?: "base64";
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

  const deliver = async () => {
    const sessionIds = await ctx.storage.listStreamSubscribers(streamId);
    for (const sessionId of sessionIds) {
      await appendToSession(ctx, sessionId, envelope);
    }
  };

  if (meta.subscriber_count > FANOUT_SUBSCRIBER_THRESHOLD) {
    ctx.state.waitUntil(deliver());
    return;
  }

  await deliver();
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

async function appendToSession(
  ctx: StreamContext,
  sessionId: string,
  envelope: FanInEnvelope,
): Promise<void> {
  if (!ctx.env.STREAMS) return;
  const sessionStreamId = `${SESSION_STREAM_PREFIX}${sessionId}`;
  const id = ctx.env.STREAMS.idFromName(sessionStreamId);
  const stub = ctx.env.STREAMS.get(id);
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
  if (!response.ok) {
    await response.arrayBuffer();
  }
}
