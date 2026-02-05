/**
 * Session cleanup using Analytics Engine queries.
 *
 * Flow:
 * 1. Query Analytics Engine for expired sessions
 * 2. For each expired session:
 *    a. Get its subscriptions from Analytics Engine
 *    b. Remove from each SubscriptionDO
 *    c. Delete the session stream from core
 */

import { fetchFromCore, type CoreClientEnv } from "./core-client";
import { createMetrics } from "./metrics";
import {
  getExpiredSessions,
  getSessionSubscriptions,
  type AnalyticsQueryEnv,
} from "./analytics-queries";

export interface CleanupEnv extends CoreClientEnv, Partial<AnalyticsQueryEnv> {
  SUBSCRIPTION_DO: DurableObjectNamespace;
  METRICS?: AnalyticsEngineDataset;
  ANALYTICS_DATASET?: string;
}

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

/**
 * Clean up a single session: remove subscriptions and delete stream.
 */
async function cleanupSession(
  env: CleanupEnv,
  analyticsEnv: AnalyticsQueryEnv,
  datasetName: string,
  session: ExpiredSession,
  metrics: ReturnType<typeof createMetrics>,
): Promise<SessionCleanupResult> {
  let subscriptionSuccesses = 0;
  let subscriptionFailures = 0;
  let streamDeleteSuccess = false;

  // Record session expiry metric
  metrics.sessionExpire(session.sessionId, 0, Date.now() - session.lastActivity);

  // Get subscriptions for this session from Analytics Engine
  const subscriptionsResult = await getSessionSubscriptions(
    analyticsEnv,
    datasetName,
    session.sessionId,
  );

  if (subscriptionsResult.error) {
    console.error(`Failed to get subscriptions for session ${session.sessionId}: ${subscriptionsResult.error}`);
    // Continue with session deletion even if subscription lookup fails
  }

  const subscriptions = subscriptionsResult.data;

  // Remove from each SubscriptionDO
  for (const sub of subscriptions) {
    try {
      const doId = env.SUBSCRIPTION_DO.idFromName(sub.streamId);
      const stub = env.SUBSCRIPTION_DO.get(doId);

      const response = await stub.fetch(
        new Request("http://do/subscriber", {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            "X-Stream-Id": sub.streamId,
          },
          body: JSON.stringify({ sessionId: session.sessionId }),
        }),
      );

      if (response.ok) {
        subscriptionSuccesses++;
      } else {
        subscriptionFailures++;
      }
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

  return {
    streamDeleteSuccess,
    subscriptionSuccesses,
    subscriptionFailures,
  };
}

/**
 * Clean up expired sessions.
 *
 * Uses Analytics Engine to find expired sessions, then:
 * - Removes their subscriptions from SubscriptionDOs
 * - Deletes their session streams from core
 */
export async function cleanupExpiredSessions(env: CleanupEnv): Promise<CleanupResult> {
  const metrics = createMetrics(env.METRICS);

  // Check if Analytics query credentials are configured
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

  // 1. Query Analytics Engine for expired sessions
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

  // 2. Process expired sessions in parallel batches
  const BATCH_SIZE = 10;

  for (let i = 0; i < expiredSessions.length; i += BATCH_SIZE) {
    const batch = expiredSessions.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(session => cleanupSession(env, analyticsEnv, datasetName, session, metrics)),
    );

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
