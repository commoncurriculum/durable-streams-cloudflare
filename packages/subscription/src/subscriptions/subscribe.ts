import { fetchFromCore } from "../client";
import { createMetrics } from "../metrics";
import { DEFAULT_SESSION_TTL_SECONDS } from "../constants";
import type { AppEnv } from "../env";
import type { SubscribeResult } from "./types";

// #region synced-to-docs:create-session-stream
export async function subscribe(
  env: AppEnv,
  projectId: string,
  streamId: string,
  sessionId: string,
  contentType = "application/json",
): Promise<SubscribeResult> {
  const start = Date.now();
  const metrics = createMetrics(env.METRICS);
  const ttlSeconds = env.SESSION_TTL_SECONDS
    ? Number.parseInt(env.SESSION_TTL_SECONDS, 10)
    : DEFAULT_SESSION_TTL_SECONDS;
  const expiresAt = Date.now() + ttlSeconds * 1000;

  // 1. Create/touch session stream in core (project-scoped)
  const coreResponse = await fetchFromCore(env, `/v1/${projectId}/stream/${sessionId}`, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "X-Stream-Expires-At": expiresAt.toString(),
    },
  });

  const isNewSession = coreResponse.ok;
  // #endregion synced-to-docs:create-session-stream

  if (!coreResponse.ok && coreResponse.status !== 409) {
    const errorText = await coreResponse.text();
    console.error(`Failed to create session stream in core: ${coreResponse.status} - ${errorText}`);
    throw new Error(`Failed to create session stream: ${coreResponse.status}`);
  }

  // #region synced-to-docs:add-subscription-to-do
  // 2. Add subscription to DO (project-scoped key)
  const doKey = `${projectId}/${streamId}`;
  const stub = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(doKey));
  try {
    await stub.addSubscriber(sessionId);
  } catch (err) {
    console.error("Failed to add subscription to DO:", err);
    // Rollback session if we just created it
    if (isNewSession) {
      try {
        await fetchFromCore(env, `/v1/${projectId}/stream/${sessionId}`, { method: "DELETE" });
      } catch (rollbackErr) {
        console.error(`Failed to rollback session stream ${sessionId}:`, rollbackErr);
      }
    }
    throw err;
  }
  // #endregion synced-to-docs:add-subscription-to-do

  // 3. Metrics
  const latencyMs = Date.now() - start;
  metrics.subscribe(streamId, sessionId, isNewSession, latencyMs);
  if (isNewSession) {
    metrics.sessionCreate(sessionId, projectId, ttlSeconds, latencyMs);
  }

  // #region synced-to-docs:subscribe-response
  return {
    sessionId,
    streamId,
    sessionStreamPath: `/v1/${projectId}/stream/${sessionId}`,
    expiresAt,
    isNewSession,
  };
  // #endregion synced-to-docs:subscribe-response
}
