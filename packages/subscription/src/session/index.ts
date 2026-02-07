import { createMetrics } from "../metrics";
import { getSessionSubscriptions } from "../analytics";
import { DEFAULT_SESSION_TTL_SECONDS } from "../constants";
import type { AppEnv } from "../env";
import type { SessionInfo, TouchSessionResult, DeleteSessionResult } from "../subscriptions/types";

// #region synced-to-docs:get-session
export async function getSession(env: AppEnv, projectId: string, sessionId: string): Promise<SessionInfo | null> {
  const doKey = `${projectId}/${sessionId}`;
  const coreResponse = await env.CORE.headStream(doKey);
  if (!coreResponse.ok) return null;

  let subscriptions: Array<{ streamId: string }> = [];
  if (env.ACCOUNT_ID && env.API_TOKEN) {
    const result = await getSessionSubscriptions(
      { ACCOUNT_ID: env.ACCOUNT_ID, API_TOKEN: env.API_TOKEN },
      env.ANALYTICS_DATASET ?? "subscriptions_metrics",
      sessionId,
    );
    if (result.error) {
      console.error("Failed to query subscriptions from Analytics Engine:", result.error);
    } else {
      subscriptions = result.data.map((s) => ({ streamId: s.streamId }));
    }
  }

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
  const ttlSeconds = env.SESSION_TTL_SECONDS
    ? Number.parseInt(env.SESSION_TTL_SECONDS, 10)
    : DEFAULT_SESSION_TTL_SECONDS;
  const expiresAt = Date.now() + ttlSeconds * 1000;

  const doKey = `${projectId}/${sessionId}`;
  const result = await env.CORE.putStream(doKey, { expiresAt });

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
