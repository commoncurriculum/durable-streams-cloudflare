import { randomUUID } from "node:crypto";

const BASE_URL = process.env.IMPLEMENTATION_TEST_URL ?? "http://localhost:8787";
const STREAM_PREFIX = "/v1/stream/";

export function streamUrl(streamId: string, params?: Record<string, string>): string {
  const base = new URL(BASE_URL);
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

export function uniqueStreamId(prefix = "impl"): string {
  return `${prefix}-${randomUUID()}`;
}

export async function createStream(
  streamId: string,
  body: string | Uint8Array = "",
  contentType = "text/plain",
): Promise<Response> {
  const response = await fetch(streamUrl(streamId), {
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
}

export async function appendStream(
  streamId: string,
  body: string | Uint8Array,
  contentType = "text/plain",
): Promise<Response> {
  const response = await fetch(streamUrl(streamId), {
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
}

export async function deleteStream(streamId: string): Promise<Response> {
  const response = await fetch(streamUrl(streamId), { method: "DELETE" });
  return response;
}

export async function readAllText(streamId: string, offset = "0"): Promise<string> {
  const response = await fetch(streamUrl(streamId, { offset }));
  if (response.status !== 200) {
    throw new Error(`GET failed: ${response.status} ${await response.text()}`);
  }
  return await response.text();
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForReaderDone(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      delay(remaining).then(() => ({ done: false, timeout: true }) as const),
    ]);
    if ("timeout" in result) return false;
    if (result.done) return true;
  }
  return false;
}
