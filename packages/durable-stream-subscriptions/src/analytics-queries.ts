/**
 * Analytics Engine Query Helpers
 *
 * Queries Analytics Engine using the SQL API.
 * Requires ACCOUNT_ID and API_TOKEN environment variables.
 *
 * @see https://developers.cloudflare.com/analytics/analytics-engine/worker-querying/
 */

export interface AnalyticsQueryEnv {
  ACCOUNT_ID: string;
  API_TOKEN: string;
}

interface AnalyticsResponse<T> {
  data: T[];
  meta: Array<{ name: string; type: string }>;
  rows: number;
  rows_before_limit_at_least: number;
}

/**
 * Execute a SQL query against Analytics Engine.
 */
async function queryAnalyticsEngine<T>(
  env: AnalyticsQueryEnv,
  query: string,
): Promise<T[]> {
  const API = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/analytics_engine/sql`;

  const response = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.API_TOKEN}`,
    },
    body: query,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Analytics Engine query failed: ${response.status} - ${errorText}`);
  }

  const result = (await response.json()) as AnalyticsResponse<T>;
  return result.data;
}

export interface SessionSubscription {
  streamId: string;
  subscribedAt?: number;
}

export interface ExpiredSessionInfo {
  sessionId: string;
  lastActivity: number;
  ttlSeconds: number;
}

/**
 * Get all streams a session is subscribed to.
 *
 * Aggregates subscribe/unsubscribe events from Analytics Engine.
 * A session is subscribed to a stream if net(subscribe - unsubscribe) > 0.
 *
 * @param env - Environment with ACCOUNT_ID and API_TOKEN
 * @param datasetName - The Analytics Engine dataset name (e.g., 'subscriptions_metrics')
 * @param sessionId - The session ID to look up
 */
export async function getSessionSubscriptions(
  env: AnalyticsQueryEnv,
  datasetName: string,
  sessionId: string,
): Promise<SessionSubscription[]> {
  // Query subscription events for this session
  // blob1 = streamId, blob2 = sessionId, blob3 = eventType ('subscribe' or 'unsubscribe')
  // index1 = 'subscription'
  const query = `
    SELECT
      blob1 as streamId,
      SUM(CASE WHEN blob3 = 'subscribe' THEN 1 ELSE -1 END) as net
    FROM ${datasetName}
    WHERE index1 = 'subscription'
      AND blob2 = '${sessionId}'
    GROUP BY blob1
    HAVING net > 0
  `;

  const results = await queryAnalyticsEngine<{ streamId: string; net: number }>(env, query);
  return results.map((r) => ({ streamId: r.streamId }));
}

/**
 * Get expired sessions for cleanup.
 *
 * Finds sessions where the last activity timestamp exceeds their TTL.
 * Uses session_create and session_touch events to determine last activity.
 *
 * @param env - Environment with ACCOUNT_ID and API_TOKEN
 * @param datasetName - The Analytics Engine dataset name
 * @param lookbackHours - How far back to look for sessions (default: 24 hours)
 */
export async function getExpiredSessions(
  env: AnalyticsQueryEnv,
  datasetName: string,
  lookbackHours = 24,
): Promise<ExpiredSessionInfo[]> {
  const nowMs = Date.now();

  // Query for sessions with their last activity time and TTL
  // blob2 = sessionId, blob3 = eventType, double3 = ttlSeconds (for session_create)
  // We need to find the max timestamp per session and check if it's expired
  const query = `
    SELECT
      blob2 as sessionId,
      MAX(timestamp) as lastActivity,
      MAX(double3) as ttlSeconds
    FROM ${datasetName}
    WHERE index1 = 'session'
      AND blob3 IN ('session_create', 'session_touch')
      AND timestamp > NOW() - INTERVAL '${lookbackHours}' HOUR
    GROUP BY blob2
    HAVING (${nowMs} - toUnixTimestamp64Milli(MAX(timestamp))) > (MAX(double3) * 1000)
  `;

  try {
    const results = await queryAnalyticsEngine<{
      sessionId: string;
      lastActivity: string;
      ttlSeconds: number;
    }>(env, query);

    return results.map((r) => ({
      sessionId: r.sessionId,
      lastActivity: new Date(r.lastActivity).getTime(),
      ttlSeconds: r.ttlSeconds,
    }));
  } catch (err) {
    console.error("Failed to query expired sessions:", err);
    return [];
  }
}

/**
 * Get all unique stream IDs that have active subscriptions.
 *
 * This is useful for cleanup to know which SubscriptionDOs to check.
 *
 * @param env - Environment with ACCOUNT_ID and API_TOKEN
 * @param datasetName - The Analytics Engine dataset name
 * @param lookbackHours - How far back to look for subscriptions
 */
export async function getActiveStreamIds(
  env: AnalyticsQueryEnv,
  datasetName: string,
  lookbackHours = 24,
): Promise<string[]> {
  const query = `
    SELECT DISTINCT blob1 as streamId
    FROM ${datasetName}
    WHERE index1 = 'subscription'
      AND blob3 = 'subscribe'
      AND timestamp > NOW() - INTERVAL '${lookbackHours}' HOUR
  `;

  try {
    const results = await queryAnalyticsEngine<{ streamId: string }>(env, query);
    return results.map((r) => r.streamId);
  } catch (err) {
    console.error("Failed to query active stream IDs:", err);
    return [];
  }
}
