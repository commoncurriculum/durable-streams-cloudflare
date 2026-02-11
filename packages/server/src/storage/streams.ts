/**
 * Stream operations via direct Durable Object invocation.
 * These functions call the StreamDO directly without going through HTTP.
 */

import type { BaseEnv } from "../http";
import { putStreamMetadata } from "./registry";

const INTERNAL_BASE_URL = "https://internal/v1/stream";

export type StreamRpcResult = {
  ok: boolean;
  status: number;
  body: string | null;
  contentType?: string | null;
};

export type PostStreamResult = {
  ok: boolean;
  status: number;
  nextOffset: string | null;
  upToDate: string | null;
  streamClosed: string | null;
  body: string | null;
};

/**
 * Check if a stream exists (HEAD)
 */
export async function headStream(
  env: BaseEnv,
  doKey: string,
): Promise<StreamRpcResult> {
  const stub = env.STREAMS.get(env.STREAMS.idFromName(doKey));
  const response = await stub.routeStreamRequest(
    doKey,
    false,
    new Request(INTERNAL_BASE_URL, { method: "HEAD" }),
  );
  const body = response.ok ? null : await response.text();
  return {
    ok: response.ok,
    status: response.status,
    body,
    contentType: response.headers.get("Content-Type"),
  };
}

/**
 * Create or touch a stream (PUT)
 */
export async function putStream(
  env: BaseEnv,
  doKey: string,
  options: { expiresAt?: number; body?: ArrayBuffer; contentType?: string },
  ctx?: ExecutionContext,
): Promise<StreamRpcResult> {
  const headers: Record<string, string> = {};
  if (options.contentType) {
    headers["Content-Type"] = options.contentType;
  }
  if (options.expiresAt) {
    headers["Stream-Expires-At"] = new Date(options.expiresAt).toISOString();
  }
  const stub = env.STREAMS.get(env.STREAMS.idFromName(doKey));
  const response = await stub.routeStreamRequest(
    doKey,
    false,
    new Request(INTERNAL_BASE_URL, {
      method: "PUT",
      headers,
      body: options.body,
    }),
  );

  // Write stream metadata to REGISTRY on creation. Use ctx.waitUntil when available,
  // otherwise await the metadata write so callers without an ExecutionContext still
  // get KV metadata.
  if (response.status === 201 && env.REGISTRY) {
    const metadataPromise = putStreamMetadata(env.REGISTRY, doKey, {
      public: false,
      content_type:
        response.headers.get("Content-Type") || "application/octet-stream",
    });
    if (ctx) {
      ctx.waitUntil(metadataPromise);
    } else {
      await metadataPromise;
    }
  }

  const body = response.ok ? null : await response.text();
  return { ok: response.ok, status: response.status, body };
}

/**
 * Delete a stream (DELETE)
 */
export async function deleteStream(
  env: BaseEnv,
  doKey: string,
): Promise<StreamRpcResult> {
  const stub = env.STREAMS.get(env.STREAMS.idFromName(doKey));
  const response = await stub.routeStreamRequest(
    doKey,
    false,
    new Request(INTERNAL_BASE_URL, { method: "DELETE" }),
  );
  const body = response.ok ? null : await response.text();
  return { ok: response.ok, status: response.status, body };
}

/**
 * Append to a stream (POST)
 */
export async function postStream(
  env: BaseEnv,
  doKey: string,
  payload: ArrayBuffer,
  contentType: string,
  producerHeaders?: {
    producerId: string;
    producerEpoch: string;
    producerSeq: string;
  },
): Promise<PostStreamResult> {
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (producerHeaders) {
    headers["Producer-Id"] = producerHeaders.producerId;
    headers["Producer-Epoch"] = producerHeaders.producerEpoch;
    headers["Producer-Seq"] = producerHeaders.producerSeq;
  }
  const stub = env.STREAMS.get(env.STREAMS.idFromName(doKey));
  const response = await stub.routeStreamRequest(
    doKey,
    false,
    new Request(INTERNAL_BASE_URL, { method: "POST", headers, body: payload }),
  );
  const body = response.ok ? null : await response.text();
  return {
    ok: response.ok,
    status: response.status,
    nextOffset: response.headers.get("Stream-Next-Offset"),
    upToDate: response.headers.get("Stream-Up-To-Date"),
    streamClosed: response.headers.get("Stream-Closed"),
    body,
  };
}
