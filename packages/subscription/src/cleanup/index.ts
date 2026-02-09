// #region synced-to-docs:cleanup-overview
/**
 * Session cleanup using Analytics Engine + SessionDO.
 *
 * Flow:
 * 1. Query Analytics Engine for expired sessions
 * 2. For each expired session:
 *    a. Get its subscriptions from SessionDO (source of truth)
 *    b. Remove from each SubscriptionDO via RPC
 *    c. Delete the session stream from core
 */
// #endregion synced-to-docs:cleanup-overview

import { createMetrics } from "../metrics";
import { logError, logWarn } from "../log";
import { getExpiredSessions } from "../analytics";
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
  project: string;
  lastActivity: number;
  ttlSeconds: number;
}

async function cleanupSession(
  env: AppEnv,
  session: ExpiredSession,
  metrics: ReturnType<typeof createMetrics>,
): Promise<SessionCleanupResult> {
  let subscriptionSuccesses = 0;
  let subscriptionFailures = 0;
  let streamDeleteSuccess = false;

  metrics.sessionExpire(session.sessionId, 0, Date.now() - session.lastActivity);

  // Get subscriptions from SessionDO (source of truth) instead of Analytics Engine
  const doKey = `${session.project}/${session.sessionId}`;
  const sessionStub = env.SESSION_DO.get(env.SESSION_DO.idFromName(doKey));
  let streamIds: string[];
  try {
    streamIds = await sessionStub.getSubscriptions();
  } catch (err) {
    logError({ sessionId: session.sessionId, project: session.project, component: "cleanup" }, "failed to get subscriptions from SessionDO", err);
    streamIds = [];
  }

  const subscriptions = streamIds.map((streamId) => ({ streamId }));

  // #region synced-to-docs:cleanup-session
  // FIX-020: Batch subscription removal RPCs with Promise.allSettled
  const SUB_REMOVAL_BATCH_SIZE = 20;
  for (let si = 0; si < subscriptions.length; si += SUB_REMOVAL_BATCH_SIZE) {
    const subBatch = subscriptions.slice(si, si + SUB_REMOVAL_BATCH_SIZE);
    const subResults = await Promise.allSettled(
      subBatch.map(async (sub) => {
        const doKey = `${session.project}/${sub.streamId}`;
        const stub = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(doKey));
        await stub.removeSubscriber(session.sessionId);
      }),
    );
    for (let j = 0; j < subResults.length; j++) {
      if (subResults[j].status === "fulfilled") {
        subscriptionSuccesses++;
      } else {
        logError({ sessionId: session.sessionId, streamId: subBatch[j].streamId, project: session.project, component: "cleanup" }, "failed to remove subscription", (subResults[j] as PromiseRejectedResult).reason);
        subscriptionFailures++;
      }
    }
  }

  // Delete session stream from core (project-scoped)
  try {
    const doKey = `${session.project}/${session.sessionId}`;
    const result = await env.CORE.deleteStream(doKey);

    if (result.ok || result.status === 404) {
      streamDeleteSuccess = true;
      metrics.sessionDelete(session.sessionId, 0);
    } else {
      logError({ sessionId: session.sessionId, project: session.project, status: result.status, component: "cleanup" }, "failed to delete session stream", result.body);
    }
  } catch (err) {
    logError({ sessionId: session.sessionId, project: session.project, component: "cleanup" }, "failed to delete session stream (exception)", err);
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
    logWarn({ component: "cleanup" }, "cleanup skipped: ACCOUNT_ID and API_TOKEN required for Analytics Engine queries");
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
    logError({ component: "cleanup" }, "failed to query expired sessions", expiredResult.error);
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
      batch.map(session => cleanupSession(env, session, metrics)),
    );
    // #endregion synced-to-docs:cleanup-main

    for (const result of results) {
      if (result.status === "fulfilled") {
        streamDeleteSuccesses += result.value.streamDeleteSuccess ? 1 : 0;
        streamDeleteFailures += result.value.streamDeleteSuccess ? 0 : 1;
        subscriptionRemoveSuccesses += result.value.subscriptionSuccesses;
        subscriptionRemoveFailures += result.value.subscriptionFailures;
      } else {
        logError({ component: "cleanup" }, "cleanup batch session rejected", result.reason);
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
