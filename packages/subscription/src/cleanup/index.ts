// #region synced-to-docs:cleanup-overview
/**
 * Session cleanup using Analytics Engine queries.
 *
 * Flow:
 * 1. Query Analytics Engine for expired sessions
 * 2. For each expired session:
 *    a. Get its subscriptions from Analytics Engine
 *    b. Remove from each SubscriptionDO via RPC
 *    c. Delete the session stream from core
 */
// #endregion synced-to-docs:cleanup-overview

import { fetchFromCore } from "../client";
import { createMetrics } from "../metrics";
import {
  getExpiredSessions,
  getSessionSubscriptions,
  type AnalyticsQueryEnv,
} from "../analytics";
import type { AppEnv } from "../env";

export interface CleanupResult {
  deleted: number;
  streamDeleteSuccesses: number;
  streamDeleteFailures: number;
  subscriptionRemoveSuccesses: number;
  subscriptionRemoveFailures: number;
}

interface SessionCleanupResult {
  streamDeleteSuccess: boolean;
  subscriptionSuccesses: number;
  subscriptionFailures: number;
}

interface ExpiredSession {
  sessionId: string;
  lastActivity: number;
  ttlSeconds: number;
}

async function cleanupSession(
  env: AppEnv,
  analyticsEnv: AnalyticsQueryEnv,
  datasetName: string,
  session: ExpiredSession,
  metrics: ReturnType<typeof createMetrics>,
): Promise<SessionCleanupResult> {
  let subscriptionSuccesses = 0;
  let subscriptionFailures = 0;
  let streamDeleteSuccess = false;

  metrics.sessionExpire(session.sessionId, 0, Date.now() - session.lastActivity);

  const subscriptionsResult = await getSessionSubscriptions(
    analyticsEnv,
    datasetName,
    session.sessionId,
  );

  if (subscriptionsResult.error) {
    console.error(`Failed to get subscriptions for session ${session.sessionId}: ${subscriptionsResult.error}`);
  }

  const subscriptions = subscriptionsResult.data;

  // #region synced-to-docs:cleanup-session
  // Remove from each SubscriptionDO via RPC
  for (const sub of subscriptions) {
    try {
      const stub = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(sub.streamId));
      await stub.removeSubscriber(session.sessionId);
      subscriptionSuccesses++;
    } catch (err) {
      console.error(
        `Failed to remove subscription ${session.sessionId} from ${sub.streamId}:`,
        err,
      );
      subscriptionFailures++;
    }
  }

  // Delete session stream from core
  try {
    const response = await fetchFromCore(
      env,
      `/v1/stream/session:${session.sessionId}`,
      { method: "DELETE" },
    );

    if (response.ok || response.status === 404) {
      streamDeleteSuccess = true;
      metrics.sessionDelete(session.sessionId, 0);
    }
  } catch (err) {
    console.error(`Failed to delete session stream ${session.sessionId}:`, err);
  }
  // #endregion synced-to-docs:cleanup-session

  return {
    streamDeleteSuccess,
    subscriptionSuccesses,
    subscriptionFailures,
  };
}

export async function cleanupExpiredSessions(env: AppEnv): Promise<CleanupResult> {
  const metrics = createMetrics(env.METRICS);

  if (!env.ACCOUNT_ID || !env.API_TOKEN) {
    console.log("Cleanup skipped: ACCOUNT_ID and API_TOKEN required for Analytics Engine queries");
    return {
      deleted: 0,
      streamDeleteSuccesses: 0,
      streamDeleteFailures: 0,
      subscriptionRemoveSuccesses: 0,
      subscriptionRemoveFailures: 0,
    };
  }

  const analyticsEnv = {
    ACCOUNT_ID: env.ACCOUNT_ID,
    API_TOKEN: env.API_TOKEN,
  };
  const datasetName = env.ANALYTICS_DATASET ?? "subscriptions_metrics";

  const expiredResult = await getExpiredSessions(analyticsEnv, datasetName);

  if (expiredResult.error) {
    console.error(`Failed to query expired sessions: ${expiredResult.error}`);
    return {
      deleted: 0,
      streamDeleteSuccesses: 0,
      streamDeleteFailures: 0,
      subscriptionRemoveSuccesses: 0,
      subscriptionRemoveFailures: 0,
    };
  }

  const expiredSessions = expiredResult.data;

  if (expiredSessions.length === 0) {
    return {
      deleted: 0,
      streamDeleteSuccesses: 0,
      streamDeleteFailures: 0,
      subscriptionRemoveSuccesses: 0,
      subscriptionRemoveFailures: 0,
    };
  }

  let streamDeleteSuccesses = 0;
  let streamDeleteFailures = 0;
  let subscriptionRemoveSuccesses = 0;
  let subscriptionRemoveFailures = 0;

  // #region synced-to-docs:cleanup-main
  const BATCH_SIZE = 10;

  for (let i = 0; i < expiredSessions.length; i += BATCH_SIZE) {
    const batch = expiredSessions.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(session => cleanupSession(env, analyticsEnv, datasetName, session, metrics)),
    );
    // #endregion synced-to-docs:cleanup-main

    for (const result of results) {
      if (result.status === "fulfilled") {
        streamDeleteSuccesses += result.value.streamDeleteSuccess ? 1 : 0;
        streamDeleteFailures += result.value.streamDeleteSuccess ? 0 : 1;
        subscriptionRemoveSuccesses += result.value.subscriptionSuccesses;
        subscriptionRemoveFailures += result.value.subscriptionFailures;
      } else {
        streamDeleteFailures++;
      }
    }
  }

  return {
    deleted: expiredSessions.length,
    streamDeleteSuccesses,
    streamDeleteFailures,
    subscriptionRemoveSuccesses,
    subscriptionRemoveFailures,
  };
}
