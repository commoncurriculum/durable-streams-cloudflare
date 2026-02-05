export interface AnalyticsEnv {
  CF_ACCOUNT_ID?: string;
  METRICS_API_TOKEN?: string;
}

export interface MetricsResponse {
  success: boolean;
  data?: unknown;
  errors?: string[];
}

export interface StreamMetrics {
  streamId: string;
  messagesWritten: number;
  bytesWritten: number;
  readsCount: number;
}

const ANALYTICS_API_BASE = "https://api.cloudflare.com/client/v4/accounts";

type TimeRange = "1h" | "24h" | "7d";
type TimeInterval = "5m" | "1h" | "1d";

const TIME_RANGE_INTERVALS: Record<TimeRange, string> = {
  "1h": "NOW() - INTERVAL '1' HOUR",
  "24h": "NOW() - INTERVAL '24' HOUR",
  "7d": "NOW() - INTERVAL '7' DAY",
};

const TIME_BUCKET_FUNCTIONS: Record<TimeInterval, string> = {
  "5m": "toStartOfFiveMinutes(timestamp)",
  "1h": "toStartOfHour(timestamp)",
  "1d": "toStartOfDay(timestamp)",
};

// Internal function for executing queries - not exposed via API
async function executeQuery(env: AnalyticsEnv, query: string): Promise<MetricsResponse> {
  if (!env.CF_ACCOUNT_ID || !env.METRICS_API_TOKEN) {
    return {
      success: false,
      errors: ["Analytics Engine credentials not configured"],
    };
  }

  try {
    const response = await fetch(
      `${ANALYTICS_API_BASE}/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.METRICS_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        errors: [`Analytics Engine API error: ${response.status} - ${errorText}`],
      };
    }

    const data = await response.json();
    return { success: true, data };
  } catch (err) {
    return {
      success: false,
      errors: [`Failed to query Analytics Engine: ${err}`],
    };
  }
}

// Escape stream IDs to prevent injection - only allows alphanumeric, dash, underscore, colon
function sanitizeStreamId(streamId: string): string {
  return streamId.replace(/[^a-zA-Z0-9_:\-]/g, "");
}

export async function getStreamMetricsSummary(
  env: AnalyticsEnv,
  timeRange: TimeRange = "24h",
): Promise<MetricsResponse> {
  const query = `
    SELECT
      blob1 as stream_id,
      SUM(double1) as messages_written,
      SUM(double2) as bytes_written,
      COUNT(*) as events
    FROM durable_streams_metrics
    WHERE timestamp > ${TIME_RANGE_INTERVALS[timeRange]}
    GROUP BY blob1
    ORDER BY messages_written DESC
    LIMIT 100
  `;

  return executeQuery(env, query);
}

export async function getTotalMetrics(
  env: AnalyticsEnv,
  timeRange: TimeRange = "24h",
): Promise<MetricsResponse> {
  const query = `
    SELECT
      SUM(double1) as total_messages,
      SUM(double2) as total_bytes,
      COUNT(DISTINCT blob1) as unique_streams,
      COUNT(*) as total_events
    FROM durable_streams_metrics
    WHERE timestamp > ${TIME_RANGE_INTERVALS[timeRange]}
  `;

  return executeQuery(env, query);
}

export async function getStreamMetrics(
  env: AnalyticsEnv,
  streamId: string,
  timeRange: TimeRange = "24h",
): Promise<MetricsResponse> {
  const safeStreamId = sanitizeStreamId(streamId);

  const query = `
    SELECT
      blob1 as stream_id,
      SUM(double1) as messages_written,
      SUM(double2) as bytes_written,
      COUNT(*) as events,
      MIN(timestamp) as first_event,
      MAX(timestamp) as last_event
    FROM durable_streams_metrics
    WHERE timestamp > ${TIME_RANGE_INTERVALS[timeRange]}
      AND blob1 = '${safeStreamId}'
    GROUP BY blob1
  `;

  return executeQuery(env, query);
}

export async function getTopStreams(
  env: AnalyticsEnv,
  timeRange: TimeRange = "24h",
  limit = 10,
): Promise<MetricsResponse> {
  // Sanitize limit to be a safe integer
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);

  const query = `
    SELECT
      blob1 as stream_id,
      SUM(double1) as messages_written,
      SUM(double2) as bytes_written,
      COUNT(*) as events
    FROM durable_streams_metrics
    WHERE timestamp > ${TIME_RANGE_INTERVALS[timeRange]}
    GROUP BY blob1
    ORDER BY messages_written DESC
    LIMIT ${safeLimit}
  `;

  return executeQuery(env, query);
}

export async function getTimeline(
  env: AnalyticsEnv,
  timeRange: TimeRange = "24h",
  interval: TimeInterval = "1h",
): Promise<MetricsResponse> {
  const query = `
    SELECT
      ${TIME_BUCKET_FUNCTIONS[interval]} as bucket,
      SUM(double1) as messages_written,
      SUM(double2) as bytes_written,
      COUNT(DISTINCT blob1) as unique_streams,
      COUNT(*) as events
    FROM durable_streams_metrics
    WHERE timestamp > ${TIME_RANGE_INTERVALS[timeRange]}
    GROUP BY bucket
    ORDER BY bucket ASC
  `;

  return executeQuery(env, query);
}
