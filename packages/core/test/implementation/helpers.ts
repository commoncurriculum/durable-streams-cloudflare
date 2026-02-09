import { randomUUID } from "node:crypto";
import { ZERO_OFFSET } from "../../src/protocol/offsets";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";
const STREAM_PREFIX = "/v1/stream/";

export function buildStreamUrl(
  baseUrl: string,
  streamId: string,
  params?: Record<string, string>,
): string {
  const base = new URL(baseUrl);
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const prefix = basePath === "/" ? STREAM_PREFIX : basePath;
  const url = new URL(`${prefix}${streamId.replace(/^\//, "")}`, base.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

export function streamUrl(streamId: string, params?: Record<string, string>): string {
  return buildStreamUrl(BASE_URL, streamId, params);
}

export function uniqueStreamId(prefix = "impl"): string {
  return `${prefix}-${randomUUID()}`;
}

export function createClient(baseUrl = BASE_URL): {
  streamUrl: (streamId: string, params?: Record<string, string>) => string;
  createStream: (
    streamId: string,
    body?: string | Uint8Array,
    contentType?: string,
  ) => Promise<Response>;
  appendStream: (
    streamId: string,
    body: string | Uint8Array,
    contentType?: string,
  ) => Promise<Response>;
  deleteStream: (streamId: string) => Promise<Response>;
  readAllText: (streamId: string, offset?: string) => Promise<string>;
} {
  return {
    streamUrl: (streamId, params) => buildStreamUrl(baseUrl, streamId, params),
    createStream: async (streamId, body = "", contentType = "text/plain") => {
      const response = await fetch(buildStreamUrl(baseUrl, streamId), {
        method: "PUT",
        headers: {
          "Content-Type": contentType,
        },
        body,
      });
      if (![200, 201].includes(response.status)) {
        throw new Error(`PUT failed: ${response.status} ${await response.text()}`);
      }
      return response;
    },
    appendStream: async (streamId, body, contentType = "text/plain") => {
      const response = await fetch(buildStreamUrl(baseUrl, streamId), {
        method: "POST",
        headers: {
          "Content-Type": contentType,
        },
        body,
      });
      if (![200, 204].includes(response.status)) {
        throw new Error(`POST failed: ${response.status} ${await response.text()}`);
      }
      return response;
    },
    deleteStream: async (streamId) => {
      return await fetch(buildStreamUrl(baseUrl, streamId), { method: "DELETE" });
    },
    readAllText: async (streamId, offset = ZERO_OFFSET) => {
      const response = await fetch(buildStreamUrl(baseUrl, streamId, { offset }));
      if (response.status !== 200) {
        throw new Error(`GET failed: ${response.status} ${await response.text()}`);
      }
      return await response.text();
    },
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until the response has `X-Cache: HIT`, returning that response.
 * Falls back to a final attempt after `timeoutMs` for clear test failure.
 */
export async function waitForCacheHit(
  url: string,
  opts?: RequestInit,
  timeoutMs = 2000,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(url, opts);
    if (res.headers.get("X-Cache") === "HIT") return res;
    await res.arrayBuffer();
    await delay(10);
  }
  return fetch(url, opts);
}

export async function waitForReaderDone(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read().catch(() => ({ done: true }) as const),
      delay(remaining).then(() => ({ done: false, timeout: true }) as const),
    ]);
    if ("timeout" in result) return false;
    if (result.done) return true;
  }
  return false;
}
