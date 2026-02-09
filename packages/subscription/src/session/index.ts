import { createMetrics } from "../metrics";
import { DEFAULT_SESSION_TTL_SECONDS } from "../constants";
import type { AppEnv } from "../env";
import type { SessionInfo, TouchSessionResult, DeleteSessionResult } from "../subscriptions/types";

// #region synced-to-docs:get-session
export async function getSession(env: AppEnv, projectId: string, sessionId: string): Promise<SessionInfo | null> {
  const doKey = `${projectId}/${sessionId}`;
  const coreResponse = await env.CORE.headStream(doKey);
  if (!coreResponse.ok) return null;

  const sessionStub = env.SESSION_DO.get(env.SESSION_DO.idFromName(doKey));
  const streamIds = await sessionStub.getSubscriptions();
  const subscriptions = streamIds.map((streamId) => ({ streamId }));

  return {
    sessionId,
    sessionStreamPath: `/v1/${projectId}/stream/${sessionId}`,
    subscriptions,
  };
}
// #endregion synced-to-docs:get-session

// #region synced-to-docs:touch-session
export async function touchSession(env: AppEnv, projectId: string, sessionId: string): Promise<TouchSessionResult> {
  const start = Date.now();
  const parsed = env.SESSION_TTL_SECONDS
    ? Number.parseInt(env.SESSION_TTL_SECONDS, 10)
    : undefined;
  const ttlSeconds = parsed !== undefined && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_SESSION_TTL_SECONDS;
  const expiresAt = Date.now() + ttlSeconds * 1000;

  const doKey = `${projectId}/${sessionId}`;
  const result = await env.CORE.putStream(doKey, { expiresAt, contentType: "application/json" });

  if (!result.ok && result.status !== 409) {
    throw new Error(`Failed to touch session: ${result.body} (status: ${result.status})`);
  }

  createMetrics(env.METRICS).sessionTouch(sessionId, Date.now() - start);
  return { sessionId, expiresAt };
}
// #endregion synced-to-docs:touch-session

export async function deleteSession(env: AppEnv, projectId: string, sessionId: string): Promise<DeleteSessionResult> {
  const start = Date.now();
  const doKey = `${projectId}/${sessionId}`;
  const result = await env.CORE.deleteStream(doKey);
  if (!result.ok && result.status !== 404) {
    throw new Error(`Failed to delete session: ${result.body} (status: ${result.status})`);
  }
  createMetrics(env.METRICS).sessionDelete(sessionId, Date.now() - start);
  return { sessionId, deleted: true };
}
