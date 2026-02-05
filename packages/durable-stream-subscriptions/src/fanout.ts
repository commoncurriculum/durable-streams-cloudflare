import { getStreamSubscribers } from "./storage";
import { createMetrics } from "./metrics";
import { fetchFromCore, type CoreClientEnv } from "./core-client";

export interface FanoutEnv extends CoreClientEnv {
  DB: D1Database;
  FANOUT_QUEUE?: Queue<FanoutMessage>;
  FANOUT_THRESHOLD?: string;
  METRICS?: AnalyticsEngineDataset;
}

export interface FanoutMessage {
  sessionId: string;
  streamId: string;
  payload: string; // base64 encoded
  contentType: string;
}

export interface FanoutResult {
  fanoutCount: number;
  successCount: number;
  failureCount: number;
}

export async function fanOutToSubscribers(
  env: FanoutEnv,
  streamId: string,
  payload: ArrayBuffer,
  contentType: string,
  producerHeaders?: Record<string, string>,
): Promise<FanoutResult> {
  const start = Date.now();
  const metrics = createMetrics(env.METRICS);
  const sessionIds = await getStreamSubscribers(env.DB, streamId);

  if (sessionIds.length === 0) {
    return { fanoutCount: 0, successCount: 0, failureCount: 0 };
  }

  const threshold = env.FANOUT_THRESHOLD ? Number.parseInt(env.FANOUT_THRESHOLD, 10) : 100;

  if (sessionIds.length > threshold && env.FANOUT_QUEUE) {
    // High subscriber count: use queue for batching
    // Chunk into batches of 100 (Cloudflare Queues limit)
    const QUEUE_BATCH_SIZE = 100;
    const payloadBase64 = arrayBufferToBase64(payload);

    for (let i = 0; i < sessionIds.length; i += QUEUE_BATCH_SIZE) {
      const batch = sessionIds.slice(i, i + QUEUE_BATCH_SIZE);
      await env.FANOUT_QUEUE.sendBatch(
        batch.map((sessionId) => ({
          body: {
            sessionId,
            streamId,
            payload: payloadBase64,
            contentType,
          },
        })),
      );
    }

    const latencyMs = Date.now() - start;
    // Queue sends are fire-and-forget; success/failure tracked in queue consumer
    metrics.fanout(streamId, sessionIds.length, sessionIds.length, 0, latencyMs);
    return { fanoutCount: sessionIds.length, successCount: sessionIds.length, failureCount: 0 };
  }

  // Low subscriber count: inline fanout with Promise.allSettled
  const results = await Promise.allSettled(
    sessionIds.map((sessionId) =>
      writeToSessionStreamWithEnv(env, sessionId, payload, contentType, producerHeaders),
    ),
  );

  // Track failures for logging/metrics
  const successes = results.filter(
    (r) => r.status === "fulfilled" && r.value.ok,
  );
  const failureCount = sessionIds.length - successes.length;
  const latencyMs = Date.now() - start;

  // Record fanout metrics
  metrics.fanout(streamId, sessionIds.length, successes.length, failureCount, latencyMs);

  // Record individual failures for debugging
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      metrics.fanoutFailure(streamId, sessionIds[index], "rejected", 0);
    } else if (!result.value.ok) {
      metrics.fanoutFailure(streamId, sessionIds[index], `http_${result.value.status}`, 0);
    }
  });

  if (failureCount > 0) {
    console.error(`Fanout failed for ${failureCount}/${sessionIds.length} sessions`);
  }

  return {
    fanoutCount: sessionIds.length,
    successCount: successes.length,
    failureCount,
  };
}

export async function writeToSessionStream(
  coreUrl: string,
  sessionId: string,
  payload: ArrayBuffer,
  contentType: string,
  authHeaders: Record<string, string> = {},
): Promise<Response> {
  const response = await fetch(`${coreUrl}/v1/stream/session:${sessionId}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      ...authHeaders,
    },
    body: payload,
  });
  return response;
}

/**
 * Write to session stream using service binding if available.
 */
async function writeToSessionStreamWithEnv(
  env: FanoutEnv,
  sessionId: string,
  payload: ArrayBuffer,
  contentType: string,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const path = `/v1/stream/session:${sessionId}`;
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    ...extraHeaders,
  };

  return fetchFromCore(env, path, {
    method: "POST",
    headers,
    body: payload,
  });
}

export async function createSessionStream(
  coreUrl: string,
  sessionId: string,
  contentType: string,
  ttlSeconds: number,
  authHeaders: Record<string, string> = {},
): Promise<Response> {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const response = await fetch(`${coreUrl}/v1/stream/session:${sessionId}`, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "X-Stream-Expires-At": expiresAt.toString(),
      ...authHeaders,
    },
  });
  return response;
}

/**
 * Create session stream using service binding if available.
 */
export function createSessionStreamWithEnv(
  env: FanoutEnv,
  sessionId: string,
  contentType: string,
  ttlSeconds: number,
): Promise<Response> {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const path = `/v1/stream/session:${sessionId}`;

  return fetchFromCore(env, path, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "X-Stream-Expires-At": expiresAt.toString(),
    },
  });
}

export async function deleteSessionStream(
  coreUrl: string,
  sessionId: string,
  authHeaders: Record<string, string> = {},
): Promise<Response> {
  const response = await fetch(`${coreUrl}/v1/stream/session:${sessionId}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  return response;
}

/**
 * Delete session stream using service binding if available.
 */
export function deleteSessionStreamWithEnv(
  env: FanoutEnv,
  sessionId: string,
): Promise<Response> {
  const path = `/v1/stream/session:${sessionId}`;
  return fetchFromCore(env, path, { method: "DELETE" });
}

export interface QueueBatchResult {
  processed: number;
  succeeded: number;
  retried: number;
}

export async function processQueueBatch(
  env: FanoutEnv,
  messages: readonly Message<FanoutMessage>[],
): Promise<QueueBatchResult> {
  const metrics = createMetrics(env.METRICS);
  let succeeded = 0;
  let retried = 0;

  for (const msg of messages) {
    const { sessionId, streamId, payload, contentType } = msg.body;
    const payloadBuffer = base64ToArrayBuffer(payload);

    try {
      // Use service binding if available for better performance
      const response = await writeToSessionStreamWithEnv(
        env,
        sessionId,
        payloadBuffer,
        contentType,
      );

      if (response.ok || response.status === 404) {
        // Success or session stream doesn't exist (stale subscription)
        // 404 means the session was deleted, so we can safely ack
        msg.ack();
        succeeded++;
      } else if (response.status >= 500) {
        // Server error - retry with backoff
        console.error(
          `Queue fanout server error for session ${sessionId}: ${response.status}`,
        );
        metrics.queueRetry(streamId, sessionId, msg.attempts || 1, `http_${response.status}`);
        msg.retry({ delaySeconds: 5 });
        retried++;
      } else {
        // Client error (4xx except 404) - don't retry, just ack to avoid infinite loop
        console.error(
          `Queue fanout client error for session ${sessionId}: ${response.status}`,
        );
        msg.ack();
        succeeded++;
      }
    } catch (err) {
      // Network or other error - retry with longer backoff
      console.error(`Queue fanout failed for session ${sessionId}:`, err);
      metrics.queueRetry(streamId, sessionId, msg.attempts || 1, "exception");
      msg.retry({ delaySeconds: 10 });
      retried++;
    }
  }

  return { processed: messages.length, succeeded, retried };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
