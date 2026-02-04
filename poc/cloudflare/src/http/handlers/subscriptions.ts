import { errorResponse } from "../../protocol/errors";
import type { StreamContext } from "../context";
import { handlePost } from "./mutation";

const SESSION_STREAM_PREFIX = "subscriptions/";

function parseSessionId(streamId: string): string | null {
  if (!streamId.startsWith(SESSION_STREAM_PREFIX)) return null;
  const sessionId = streamId.slice(SESSION_STREAM_PREFIX.length);
  return sessionId.length > 0 ? sessionId : null;
}

async function parseJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const payload = await request.json();
    if (!payload || typeof payload !== "object") return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function ensureSessionStream(ctx: StreamContext, streamId: string): Promise<void> {
  const meta = await ctx.getStream(streamId);
  if (meta) return;
  await ctx.storage.insertStream({
    streamId,
    contentType: "application/json",
    closed: false,
    ttlSeconds: null,
    expiresAt: null,
    createdAt: Date.now(),
  });
}

export async function handleInternalSubscriptions(
  ctx: StreamContext,
  streamId: string,
  request: Request,
): Promise<Response> {
  return ctx.state.blockConcurrencyWhile(async () => {
    const sessionId = parseSessionId(streamId);
    if (!sessionId) return errorResponse(400, "invalid session stream id");

    const method = request.method.toUpperCase();
    if (method === "GET") {
      const streams = await ctx.storage.listSessionSubscriptions();
      return new Response(JSON.stringify(streams), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }

    if (method !== "POST" && method !== "DELETE") {
      return errorResponse(405, "method not allowed");
    }

    const payload = await parseJson(request);
    if (!payload) return errorResponse(400, "invalid JSON body");

    const payloadSessionId = extractString(payload, "sessionId");
    if (payloadSessionId && payloadSessionId !== sessionId) {
      return errorResponse(400, "sessionId mismatch");
    }

    const targetStreamId = extractString(payload, "streamId");
    if (!targetStreamId) return errorResponse(400, "missing streamId");

    const now = Date.now();
    if (method === "POST") {
      await ensureSessionStream(ctx, streamId);

      const updateResponse = await updateStreamSubscriber(ctx, targetStreamId, sessionId, "POST");
      if (updateResponse.status !== 204) return updateResponse;

      const stored = await ctx.storage.addSessionSubscription(targetStreamId, now);
      if (!stored) return new Response(null, { status: 204 });

      return new Response(null, { status: 204 });
    }

    const updateResponse = await updateStreamSubscriber(ctx, targetStreamId, sessionId, "DELETE");
    if (updateResponse.status !== 204) return updateResponse;

    await ctx.storage.removeSessionSubscription(targetStreamId);
    return new Response(null, { status: 204 });
  });
}

export async function handleInternalSubscribers(
  ctx: StreamContext,
  streamId: string,
  request: Request,
): Promise<Response> {
  return ctx.state.blockConcurrencyWhile(async () => {
    const meta = await ctx.getStream(streamId);
    if (!meta) return errorResponse(404, "stream not found");

    const method = request.method.toUpperCase();
    if (method !== "POST" && method !== "DELETE") {
      return errorResponse(405, "method not allowed");
    }

    const payload = await parseJson(request);
    if (!payload) return errorResponse(400, "invalid JSON body");
    const sessionId = extractString(payload, "sessionId");
    if (!sessionId) return errorResponse(400, "missing sessionId");

    const now = Date.now();
    if (method === "POST") {
      await ctx.storage.addStreamSubscriber(streamId, sessionId, now);
      return new Response(null, { status: 204 });
    }

    await ctx.storage.removeStreamSubscriber(streamId, sessionId);
    return new Response(null, { status: 204 });
  });
}

export async function handleInternalFanInAppend(
  ctx: StreamContext,
  streamId: string,
  request: Request,
): Promise<Response> {
  return ctx.state.blockConcurrencyWhile(async () => {
    const sessionId = parseSessionId(streamId);
    if (!sessionId) return errorResponse(400, "invalid session stream id");

    await ensureSessionStream(ctx, streamId);
    return await handlePost(ctx, streamId, request);
  });
}

async function updateStreamSubscriber(
  ctx: StreamContext,
  streamId: string,
  sessionId: string,
  method: "POST" | "DELETE",
): Promise<Response> {
  if (!ctx.env.STREAMS) return errorResponse(500, "STREAMS binding unavailable");

  const id = ctx.env.STREAMS.idFromName(streamId);
  const stub = ctx.env.STREAMS.get(id);
  const url = new URL("https://internal/internal/subscribers");
  const headers = new Headers({ "Content-Type": "application/json", "X-Stream-Id": streamId });
  const response = await stub.fetch(
    new Request(url, {
      method,
      headers,
      body: JSON.stringify({ sessionId }),
    }),
  );
  if (!response.ok) {
    const message = await response.text();
    return new Response(message || "stream subscriber update failed", {
      status: response.status,
    });
  }
  return new Response(null, { status: 204 });
}
