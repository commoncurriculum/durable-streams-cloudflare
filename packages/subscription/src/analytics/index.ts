/**
 * Analytics Engine Query Helpers
 *
 * Queries Analytics Engine using the SQL API.
 * Requires ACCOUNT_ID and API_TOKEN environment variables.
 *
 * @see https://developers.cloudflare.com/analytics/analytics-engine/worker-querying/
 */

import { SESSION_ID_PATTERN } from "../constants";
import { logError } from "../log";

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

export type QueryErrorType = "query" | "network" | "rate_limit" | "auth" | "validation";

export interface QueryResult<T> {
  data: T;
  error?: string;
  errorType?: QueryErrorType;
}

/**
 * Pattern for valid dataset names.
 * Allows alphanumeric characters, hyphens, and underscores.
 */
const DATASET_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validates a dataset name against the allowed pattern.
 */
function isValidDatasetName(name: string): boolean {
  return DATASET_NAME_PATTERN.test(name);
}

/**
 * Validates a session ID against the allowed pattern.
 */
function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

/**
 * Determines the error type based on HTTP status code.
 */
function getErrorType(status: number): QueryErrorType {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  return "query";
}

/**
 * Execute a SQL query against Analytics Engine.
 */
async function queryAnalyticsEngine<T>(
  env: AnalyticsQueryEnv,
  query: string,
): Promise<QueryResult<T[]>> {
  const API = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/analytics_engine/sql`;

  try {
    const response = await fetch(API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.API_TOKEN}`,
      },
      body: query,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        data: [],
        error: `Analytics Engine query failed: ${response.status} - ${errorText}`,
        errorType: getErrorType(response.status),
      };
    }

    const result = (await response.json()) as AnalyticsResponse<T>;
    return { data: result.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logError({ component: "analytics" }, "analytics engine query failed (network)", err);
    return {
      data: [],
      error: message,
      errorType: "network",
    };
  }
}

export interface SessionSubscription {
  streamId: string;
  subscribedAt?: number;
}

export interface ExpiredSessionInfo {
  sessionId: string;
  project: string;
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
): Promise<QueryResult<SessionSubscription[]>> {
  // Validate inputs to prevent SQL injection
  if (!isValidDatasetName(datasetName)) {
    return { data: [], error: "Invalid dataset name format", errorType: "validation" };
  }

  if (!isValidSessionId(sessionId)) {
    return { data: [], error: "Invalid sessionId format", errorType: "validation" };
  }

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

  const result = await queryAnalyticsEngine<{ streamId: string; net: number }>(env, query);

  if (result.error) {
    return { data: [], error: result.error, errorType: result.errorType };
  }

  return {
    data: result.data.map((r) => ({ streamId: r.streamId })),
  };
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
): Promise<QueryResult<ExpiredSessionInfo[]>> {
  // Validate inputs
  if (!isValidDatasetName(datasetName)) {
    return { data: [], error: "Invalid dataset name format", errorType: "validation" };
  }

  // Ensure lookbackHours is positive
  const safeLookbackHours = lookbackHours > 0 ? lookbackHours : 24;
  const nowMs = Date.now();

  // Query for sessions with their last activity time, TTL, and project
  // blob1 = project (from session_create), blob2 = sessionId, blob3 = eventType, double3 = ttlSeconds
  // IMPORTANT: Use argMax to get TTL and project from the most recent event, not MAX
  const query = `
    SELECT
      blob2 as sessionId,
      argMax(blob1, timestamp) as project,
      MAX(timestamp) as lastActivity,
      argMax(double3, timestamp) as ttlSeconds
    FROM ${datasetName}
    WHERE index1 = 'session'
      AND blob3 IN ('session_create', 'session_touch')
      AND timestamp > NOW() - INTERVAL '${safeLookbackHours}' HOUR
    GROUP BY blob2
    HAVING (${nowMs} - toUnixTimestamp64Milli(MAX(timestamp))) > (argMax(double3, timestamp) * 1000)
  `;

  const result = await queryAnalyticsEngine<{
    sessionId: string;
    project: string;
    lastActivity: string;
    ttlSeconds: number;
  }>(env, query);

  if (result.error) {
    return { data: [], error: result.error, errorType: result.errorType };
  }

  return {
    data: result.data.map((r) => ({
      sessionId: r.sessionId,
      project: r.project,
      lastActivity: new Date(r.lastActivity).getTime(),
      ttlSeconds: r.ttlSeconds,
    })),
  };
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
): Promise<QueryResult<string[]>> {
  // Validate inputs
  if (!isValidDatasetName(datasetName)) {
    return { data: [], error: "Invalid dataset name format", errorType: "validation" };
  }

  // Ensure lookbackHours is positive
  const safeLookbackHours = lookbackHours > 0 ? lookbackHours : 24;

  const query = `
    SELECT DISTINCT blob1 as streamId
    FROM ${datasetName}
    WHERE index1 = 'subscription'
      AND blob3 = 'subscribe'
      AND timestamp > NOW() - INTERVAL '${safeLookbackHours}' HOUR
  `;

  const result = await queryAnalyticsEngine<{ streamId: string }>(env, query);

  if (result.error) {
    return { data: [], error: result.error, errorType: result.errorType };
  }

  return {
    data: result.data.map((r) => r.streamId),
  };
}
