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
  _contentType = "application/json",
): Promise<SubscribeResult> {
  const start = Date.now();
  const metrics = createMetrics(env.METRICS);
  const ttlSeconds = env.SESSION_TTL_SECONDS
    ? Number.parseInt(env.SESSION_TTL_SECONDS, 10)
    : DEFAULT_SESSION_TTL_SECONDS;
  const expiresAt = Date.now() + ttlSeconds * 1000;

  // 1. Create/touch session stream in core (project-scoped)
  const sessionDoKey = `${projectId}/${sessionId}`;
  const coreResponse = await env.CORE.putStream(sessionDoKey, { expiresAt, contentType: "application/octet-stream" });

  const isNewSession = coreResponse.ok;
  // #endregion synced-to-docs:create-session-stream

  if (!coreResponse.ok && coreResponse.status !== 409) {
    throw new Error(`Failed to create session stream: ${coreResponse.body} (status: ${coreResponse.status})`);
  }

  // #region synced-to-docs:add-subscription-to-do
  // 2. Add subscription to DO (project-scoped key)
  const streamDoKey = `${projectId}/${streamId}`;
  const stub = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(streamDoKey));
  try {
    await stub.addSubscriber(sessionId);
  } catch (err) {
    // Rollback session if we just created it
    if (isNewSession) {
      try {
        await env.CORE.deleteStream(sessionDoKey);
      } catch (rollbackErr) {
        console.error(`Failed to rollback session stream ${sessionId}:`, rollbackErr);
      }
    }
    throw err;
  }
  // #endregion synced-to-docs:add-subscription-to-do

  // 3. Track subscription on the session DO
  const sessionDoStubKey = `${projectId}/${sessionId}`;
  const sessionStub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionDoStubKey));
  await sessionStub.addSubscription(streamId);

  // 4. Metrics
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
