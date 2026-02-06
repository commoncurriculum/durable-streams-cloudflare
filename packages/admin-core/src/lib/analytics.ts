import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import type { AnalyticsRow, ServiceBinding } from "../types";

async function queryAnalytics(sql: string): Promise<AnalyticsRow[]> {
  const accountId = (env as Record<string, unknown>).CF_ACCOUNT_ID as
    | string
    | undefined;
  const apiToken = (env as Record<string, unknown>).CF_API_TOKEN as
    | string
    | undefined;

  if (!accountId || !apiToken) {
    throw new Error(
      "CF_ACCOUNT_ID and CF_API_TOKEN are required for analytics queries",
    );
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "text/plain",
      },
      body: sql,
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Analytics Engine query failed (${response.status}): ${text}`,
    );
  }

  const body = (await response.json()) as { data?: AnalyticsRow[] };
  return body.data ?? [];
}

const QUERIES = {
  systemStats: `
    SELECT blob2 as event_type, count() as total, sum(double2) as total_bytes
    FROM durable_streams_metrics
    WHERE timestamp > NOW() - INTERVAL '1' HOUR
    GROUP BY blob2
  `,

  streamList: `
    SELECT blob1 as stream_id, min(timestamp) as first_seen, max(timestamp) as last_seen, count() as total_events
    FROM durable_streams_metrics
    WHERE timestamp > NOW() - INTERVAL '24' HOUR AND blob2 != 'read'
    GROUP BY blob1
    ORDER BY last_seen DESC
    LIMIT 100
  `,

  hotStreams: (limit: number) => `
    SELECT blob1 as stream_id, count() as events, sum(double2) as bytes
    FROM durable_streams_metrics
    WHERE timestamp > NOW() - INTERVAL '5' MINUTE AND blob2 = 'append'
    GROUP BY blob1
    ORDER BY events DESC
    LIMIT ${limit}
  `,

  timeseries: (windowMinutes: number) => `
    SELECT intDiv(toUInt32(timestamp), 60) * 60 as bucket, blob2 as event_type, count() as total, sum(double2) as bytes
    FROM durable_streams_metrics
    WHERE timestamp > NOW() - INTERVAL '${windowMinutes}' MINUTE
    GROUP BY bucket, event_type
    ORDER BY bucket
  `,
};

export const getStats = createServerFn({ method: "GET" }).handler(async () => {
  return queryAnalytics(QUERIES.systemStats);
});

export const getStreams = createServerFn({ method: "GET" }).handler(
  async () => {
    return queryAnalytics(QUERIES.streamList);
  },
);

export const getHotStreams = createServerFn({ method: "GET" }).handler(
  async () => {
    return queryAnalytics(QUERIES.hotStreams(20));
  },
);

export const getTimeseries = createServerFn({ method: "GET" }).handler(
  async () => {
    return queryAnalytics(QUERIES.timeseries(60));
  },
);

export const inspectStream = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: streamId }) => {
    const core = (env as Record<string, unknown>).CORE as ServiceBinding;
    const adminToken = (env as Record<string, unknown>).ADMIN_TOKEN as
      | string
      | undefined;

    const headers: Record<string, string> = {};
    if (adminToken) headers["Authorization"] = `Bearer ${adminToken}`;

    const response = await core.fetch(
      new Request(
        `https://internal/v1/stream/${encodeURIComponent(streamId)}/admin`,
        { headers },
      ),
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Stream inspect failed (${response.status}): ${text}`);
    }

    return response.json();
  });

export const sendTestAction = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      streamId: string;
      action: "create" | "append";
      contentType?: string;
      body: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const core = (env as Record<string, unknown>).CORE as ServiceBinding;
    const adminToken = (env as Record<string, unknown>).ADMIN_TOKEN as
      | string
      | undefined;

    const contentType = data.contentType ?? "application/json";
    const method = data.action === "create" ? "PUT" : "POST";

    const reqHeaders: Record<string, string> = {
      "Content-Type": contentType,
    };
    if (adminToken) reqHeaders["Authorization"] = `Bearer ${adminToken}`;

    const response = await core.fetch(
      new Request(
        `https://internal/v1/stream/${encodeURIComponent(data.streamId)}`,
        {
          method,
          headers: reqHeaders,
          body: data.body,
        },
      ),
    );

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    };
  });

export const getSseProxyUrl = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: streamId }) => {
    // Return the proxy URL for the client to connect to
    // The actual SSE proxying happens via a server route
    return `/api/sse/${encodeURIComponent(streamId)}`;
  });
