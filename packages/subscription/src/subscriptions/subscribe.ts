import { fetchFromCore } from "../client";
import { createMetrics } from "../metrics";
import type { SubscriptionDO } from "./do";
import type { SubscribeResult } from "./types";

interface Env {
  SUBSCRIPTION_DO: DurableObjectNamespace<SubscriptionDO>;
  METRICS?: AnalyticsEngineDataset;
  SESSION_TTL_SECONDS?: string;
  CORE?: Fetcher;
  CORE_URL: string;
  AUTH_TOKEN?: string;
}

export async function subscribe(
  env: Env,
  streamId: string,
  sessionId: string,
  contentType = "application/json",
): Promise<SubscribeResult> {
  const start = Date.now();
  const metrics = createMetrics(env.METRICS);
  const ttlSeconds = env.SESSION_TTL_SECONDS
    ? Number.parseInt(env.SESSION_TTL_SECONDS, 10)
    : 1800;
  const expiresAt = Date.now() + ttlSeconds * 1000;

  // 1. Create/touch session stream in core
  const coreResponse = await fetchFromCore(env, `/v1/stream/session:${sessionId}`, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "X-Stream-Expires-At": expiresAt.toString(),
    },
  });

  const isNewSession = coreResponse.ok;

  if (!coreResponse.ok && coreResponse.status !== 409) {
    const errorText = await coreResponse.text();
    console.error(`Failed to create session stream in core: ${coreResponse.status} - ${errorText}`);
    throw new Error(`Failed to create session stream: ${coreResponse.status}`);
  }

  // 2. Add subscription to DO
  const stub = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(streamId));
  try {
    await stub.addSubscriber(sessionId);
  } catch (err) {
    console.error("Failed to add subscription to DO:", err);
    // Rollback session if we just created it
    if (isNewSession) {
      try {
        await fetchFromCore(env, `/v1/stream/session:${sessionId}`, { method: "DELETE" });
      } catch (rollbackErr) {
        console.error(`Failed to rollback session stream ${sessionId}:`, rollbackErr);
      }
    }
    throw err;
  }

  // 3. Metrics
  const latencyMs = Date.now() - start;
  metrics.subscribe(streamId, sessionId, isNewSession, latencyMs);
  if (isNewSession) {
    metrics.sessionCreate(sessionId, ttlSeconds, latencyMs);
  }

  return {
    sessionId,
    streamId,
    sessionStreamPath: `/v1/stream/session:${sessionId}`,
    expiresAt,
    isNewSession,
  };
}
