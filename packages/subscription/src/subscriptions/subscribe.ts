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
): Promise<SubscribeResult> {
  const start = Date.now();
  const metrics = createMetrics(env.METRICS);
  const parsed = env.SESSION_TTL_SECONDS
    ? Number.parseInt(env.SESSION_TTL_SECONDS, 10)
    : undefined;
  const ttlSeconds = parsed !== undefined && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_SESSION_TTL_SECONDS;
  const expiresAt = Date.now() + ttlSeconds * 1000;

  // 0. Look up the source stream's content type so the session stream matches
  const sourceDoKey = `${projectId}/${streamId}`;
  const sourceHead = await env.CORE.headStream(sourceDoKey);
  if (!sourceHead.ok) {
    throw new Error(`Source stream not found: ${sourceDoKey} (status: ${sourceHead.status})`);
  }
  if (!sourceHead.contentType) {
    throw new Error(`Source stream ${sourceDoKey} has no content type`);
  }
  const contentType = sourceHead.contentType;

  // 1. Create/touch session stream in core with the same content type
  const sessionDoKey = `${projectId}/${sessionId}`;
  const coreResponse = await env.CORE.putStream(sessionDoKey, { expiresAt, contentType });

  const isNewSession = coreResponse.ok;
  // #endregion synced-to-docs:create-session-stream

  if (!coreResponse.ok && coreResponse.status !== 409) {
    throw new Error(`Failed to create session stream: ${coreResponse.body} (status: ${coreResponse.status})`);
  }

  // If session stream already exists, verify content type matches
  if (coreResponse.status === 409) {
    const sessionHead = await env.CORE.headStream(sessionDoKey);
    if (sessionHead.ok && sessionHead.contentType && sessionHead.contentType !== contentType) {
      throw new Error(
        `Content type mismatch: session stream is ${sessionHead.contentType} but source stream ${streamId} is ${contentType}. ` +
        `A session can only subscribe to streams of the same content type.`,
      );
    }
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
