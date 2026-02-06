import type { AdminSubscriptionEnv, AnalyticsRow } from "./types";

const STREAM_ID_PATTERN = /^[a-zA-Z0-9_\-:.]+$/;

export async function queryAnalytics(env: AdminSubscriptionEnv, sql: string): Promise<AnalyticsRow[]> {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    throw new Error("CF_ACCOUNT_ID and CF_API_TOKEN are required for analytics queries");
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: sql,
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Analytics Engine query failed (${response.status}): ${text}`);
  }

  const body = await response.json<{ data: AnalyticsRow[] }>();
  return body.data ?? [];
}

export const QUERIES = {
  systemStats: `
    SELECT blob3 as event_type, count() as total
    FROM subscriptions_metrics
    WHERE timestamp > NOW() - INTERVAL '1' HOUR
    GROUP BY blob3
  `,

  activeSessions: `
    SELECT blob2 as session_id, max(timestamp) as last_seen, count() as events
    FROM subscriptions_metrics
    WHERE timestamp > NOW() - INTERVAL '24' HOUR
      AND index1 = 'session'
      AND blob3 IN ('session_create', 'session_touch')
    GROUP BY blob2
    ORDER BY last_seen DESC
    LIMIT 100
  `,

  activeStreams: `
    SELECT blob1 as stream_id, min(timestamp) as first_seen, max(timestamp) as last_seen, count() as total_events
    FROM subscriptions_metrics
    WHERE timestamp > NOW() - INTERVAL '24' HOUR
      AND blob1 != ''
    GROUP BY blob1
    ORDER BY last_seen DESC
    LIMIT 100
  `,

  hotStreams: (limit: number) => `
    SELECT blob1 as stream_id, count() as publishes, sum(double2) as fanout_count
    FROM subscriptions_metrics
    WHERE timestamp > NOW() - INTERVAL '5' MINUTE
      AND index1 = 'publish'
    GROUP BY blob1
    ORDER BY publishes DESC
    LIMIT ${limit}
  `,

  timeseries: (windowMinutes: number) => `
    SELECT intDiv(toUInt32(timestamp), 60) * 60 as bucket, blob3 as event_type, count() as total
    FROM subscriptions_metrics
    WHERE timestamp > NOW() - INTERVAL '${windowMinutes}' MINUTE
    GROUP BY bucket, event_type
    ORDER BY bucket
  `,

  fanoutStats: `
    SELECT sum(double2) as successes, sum(double3) as failures, avg(double4) as avg_latency_ms, count() as total
    FROM subscriptions_metrics
    WHERE timestamp > NOW() - INTERVAL '1' HOUR
      AND index1 = 'fanout'
  `,

  cleanupStats: `
    SELECT sum(double1) as expired_sessions, sum(double2) as streams_deleted, sum(double3) as subscriptions_removed, count() as batches
    FROM subscriptions_metrics
    WHERE timestamp > NOW() - INTERVAL '24' HOUR
      AND index1 = 'cleanup'
  `,

  streamSubscribers: (streamId: string) => {
    if (!STREAM_ID_PATTERN.test(streamId)) {
      throw new Error(`Invalid stream ID: ${streamId}`);
    }
    return `
      SELECT blob2 as session_id, sum(double1) as net
      FROM subscriptions_metrics
      WHERE index1 = 'subscription'
        AND blob1 = '${streamId}'
      GROUP BY blob2
      HAVING net > 0
      ORDER BY session_id
    `;
  },

  publishErrors: `
    SELECT blob1 as stream_id, blob4 as error_type, count() as total, max(timestamp) as last_seen
    FROM subscriptions_metrics
    WHERE timestamp > NOW() - INTERVAL '24' HOUR
      AND index1 = 'publish_error'
    GROUP BY blob1, blob4
    ORDER BY last_seen DESC
    LIMIT 50
  `,
};
