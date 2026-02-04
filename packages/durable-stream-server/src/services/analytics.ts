/**
 * Analytics Engine query helper
 *
 * Queries the Cloudflare Analytics Engine SQL API to retrieve
 * metrics data for durable streams.
 */

export interface AnalyticsQueryResult<T> {
  data: T[];
  meta?: {
    name: string;
    type: string;
  }[];
  rows?: number;
  rows_before_limit_at_least?: number;
}

export interface AnalyticsResponse<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: AnalyticsQueryResult<T>;
}

/**
 * Query the Analytics Engine SQL API
 */
export async function queryMetrics<T>(
  accountId: string,
  apiToken: string,
  sql: string
): Promise<T[]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "text/plain",
      },
      body: sql,
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Analytics Engine query failed: ${response.status} ${text}`);
  }

  const result = (await response.json()) as AnalyticsResponse<T>;

  if (!result.success || !result.result) {
    const errorMsg = result.errors?.[0]?.message || "Unknown error";
    throw new Error(`Analytics Engine query failed: ${errorMsg}`);
  }

  return result.result.data || [];
}

/**
 * Hot streams - top streams by message volume in the last N minutes
 */
export interface HotStreamResult {
  stream_id: string;
  message_count: number;
  byte_count: number;
}

export async function getHotStreams(
  accountId: string,
  apiToken: string,
  options: { minutes?: number; limit?: number } = {}
): Promise<HotStreamResult[]> {
  const { minutes = 5, limit = 10 } = options;

  const sql = `
    SELECT
      blob1 AS stream_id,
      SUM(_sample_interval) AS message_count,
      SUM(double2 * _sample_interval) AS byte_count
    FROM durable_streams_metrics
    WHERE timestamp > NOW() - INTERVAL '${minutes}' MINUTE
      AND blob3 IS NULL
    GROUP BY blob1
    ORDER BY message_count DESC
    LIMIT ${limit}
  `;

  return queryMetrics<HotStreamResult>(accountId, apiToken, sql);
}

/**
 * Stream throughput - messages per minute for a specific stream
 */
export interface ThroughputBucket {
  minute: number;
  messages: number;
  bytes: number;
}

export async function getStreamThroughput(
  accountId: string,
  apiToken: string,
  streamId: string,
  options: { minutes?: number } = {}
): Promise<ThroughputBucket[]> {
  const { minutes = 60 } = options;

  // Escape single quotes in streamId to prevent SQL injection
  const safeStreamId = streamId.replace(/'/g, "''");

  const sql = `
    SELECT
      intDiv(toUInt32(timestamp), 60) * 60 AS minute,
      SUM(_sample_interval) AS messages,
      SUM(double2 * _sample_interval) AS bytes
    FROM durable_streams_metrics
    WHERE blob1 = '${safeStreamId}'
      AND timestamp > NOW() - INTERVAL '${minutes}' MINUTE
      AND blob3 IS NULL
    GROUP BY minute
    ORDER BY minute ASC
  `;

  return queryMetrics<ThroughputBucket>(accountId, apiToken, sql);
}

/**
 * Active subscribers - current subscriber count for a stream
 */
export interface SubscriberCount {
  active_subscribers: number;
}

export async function getActiveSubscribers(
  accountId: string,
  apiToken: string,
  streamId: string
): Promise<number> {
  // Escape single quotes in streamId to prevent SQL injection
  const safeStreamId = streamId.replace(/'/g, "''");

  const sql = `
    SELECT SUM(double1 * _sample_interval) AS active_subscribers
    FROM durable_streams_metrics
    WHERE blob1 = '${safeStreamId}' AND blob3 IS NOT NULL
  `;

  const results = await queryMetrics<SubscriberCount>(accountId, apiToken, sql);
  return results[0]?.active_subscribers || 0;
}

/**
 * System throughput - total messages/bytes across all streams
 */
export interface SystemThroughput {
  total_messages: number;
  total_bytes: number;
}

export async function getSystemThroughput(
  accountId: string,
  apiToken: string,
  options: { minutes?: number } = {}
): Promise<SystemThroughput> {
  const { minutes = 5 } = options;

  const sql = `
    SELECT
      SUM(_sample_interval) AS total_messages,
      SUM(double2 * _sample_interval) AS total_bytes
    FROM durable_streams_metrics
    WHERE timestamp > NOW() - INTERVAL '${minutes}' MINUTE
      AND blob3 IS NULL
  `;

  const results = await queryMetrics<SystemThroughput>(accountId, apiToken, sql);
  return results[0] || { total_messages: 0, total_bytes: 0 };
}

/**
 * Total active subscribers across all streams
 */
export async function getTotalActiveSubscribers(
  accountId: string,
  apiToken: string
): Promise<number> {
  const sql = `
    SELECT SUM(double1 * _sample_interval) AS total_subscribers
    FROM durable_streams_metrics
    WHERE blob3 IS NOT NULL
  `;

  const results = await queryMetrics<{ total_subscribers: number }>(
    accountId,
    apiToken,
    sql
  );
  return results[0]?.total_subscribers || 0;
}
