import { fetchFromCore } from "../client";
import { createMetrics } from "../metrics";
import { getSessionSubscriptions } from "../analytics";
import { DEFAULT_SESSION_TTL_SECONDS } from "../constants";
import type { AppEnv } from "../env";
import type { SessionInfo, TouchSessionResult, DeleteSessionResult } from "../subscriptions/types";

// #region synced-to-docs:get-session
export async function getSession(env: AppEnv, sessionId: string): Promise<SessionInfo | null> {
  const coreResponse = await fetchFromCore(env, `/v1/stream/session:${sessionId}`, { method: "HEAD" });
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
    sessionStreamPath: `/v1/stream/session:${sessionId}`,
    subscriptions,
  };
}
// #endregion synced-to-docs:get-session

// #region synced-to-docs:touch-session
export async function touchSession(env: AppEnv, sessionId: string): Promise<TouchSessionResult> {
  const start = Date.now();
  const ttlSeconds = env.SESSION_TTL_SECONDS
    ? Number.parseInt(env.SESSION_TTL_SECONDS, 10)
    : DEFAULT_SESSION_TTL_SECONDS;
  const expiresAt = Date.now() + ttlSeconds * 1000;

  const response = await fetchFromCore(env, `/v1/stream/session:${sessionId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Stream-Expires-At": expiresAt.toString(),
    },
  });

  if (!response.ok && response.status !== 409) {
    throw new Error(`Failed to touch session: ${sessionId} (status: ${response.status})`);
  }

  createMetrics(env.METRICS).sessionTouch(sessionId, Date.now() - start);
  return { sessionId, expiresAt };
}
// #endregion synced-to-docs:touch-session

export async function deleteSession(env: AppEnv, sessionId: string): Promise<DeleteSessionResult> {
  const start = Date.now();
  const response = await fetchFromCore(env, `/v1/stream/session:${sessionId}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete session: ${sessionId}`);
  }
  createMetrics(env.METRICS).sessionDelete(sessionId, Date.now() - start);
  return { sessionId, deleted: true };
}
