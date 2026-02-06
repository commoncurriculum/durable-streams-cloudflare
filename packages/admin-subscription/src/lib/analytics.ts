import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import type { AnalyticsRow, ServiceBinding } from "../types";

const STREAM_ID_PATTERN = /^[a-zA-Z0-9_\-:.]+$/;

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

export const getStats = createServerFn({ method: "GET" }).handler(async () => {
  const [stats, fanout, cleanup] = await Promise.all([
    queryAnalytics(QUERIES.systemStats),
    queryAnalytics(QUERIES.fanoutStats),
    queryAnalytics(QUERIES.cleanupStats),
  ]);
  return { stats, fanout, cleanup };
});

export const getSessions = createServerFn({ method: "GET" }).handler(
  async () => {
    return queryAnalytics(QUERIES.activeSessions);
  },
);

export const getStreams = createServerFn({ method: "GET" }).handler(
  async () => {
    return queryAnalytics(QUERIES.activeStreams);
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

export const getErrors = createServerFn({ method: "GET" }).handler(
  async () => {
    return queryAnalytics(QUERIES.publishErrors);
  },
);

export const inspectSession = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: sessionId }) => {
    const subscription = (env as Record<string, unknown>).SUBSCRIPTION as ServiceBinding;
    const adminToken = (env as Record<string, unknown>).ADMIN_TOKEN as
      | string
      | undefined;

    const headers: Record<string, string> = {};
    if (adminToken) headers["Authorization"] = `Bearer ${adminToken}`;

    const response = await subscription.fetch(
      new Request(
        `https://internal/v1/session/${encodeURIComponent(sessionId)}`,
        { headers },
      ),
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Session inspect failed (${response.status}): ${text}`,
      );
    }

    return response.json();
  });

export const inspectStreamSubscribers = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: streamId }) => {
    return queryAnalytics(QUERIES.streamSubscribers(streamId));
  });

export const sendTestAction = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      action: "subscribe" | "unsubscribe" | "publish" | "touch" | "delete";
      sessionId?: string;
      streamId?: string;
      contentType?: string;
      body?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const subscription = (env as Record<string, unknown>).SUBSCRIPTION as ServiceBinding;
    const adminToken = (env as Record<string, unknown>).ADMIN_TOKEN as
      | string
      | undefined;

    const authHeaders: Record<string, string> = {};
    if (adminToken) authHeaders["Authorization"] = `Bearer ${adminToken}`;

    let request: Request;

    switch (data.action) {
      case "subscribe": {
        if (!data.sessionId || !data.streamId) {
          throw new Error("subscribe requires sessionId and streamId");
        }
        request = new Request("https://internal/v1/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            sessionId: data.sessionId,
            streamId: data.streamId,
          }),
        });
        break;
      }
      case "unsubscribe": {
        if (!data.sessionId || !data.streamId) {
          throw new Error("unsubscribe requires sessionId and streamId");
        }
        request = new Request("https://internal/v1/unsubscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            sessionId: data.sessionId,
            streamId: data.streamId,
          }),
        });
        break;
      }
      case "publish": {
        if (!data.streamId) {
          throw new Error("publish requires streamId");
        }
        const contentType = data.contentType ?? "application/json";
        request = new Request(
          `https://internal/v1/publish/${encodeURIComponent(data.streamId)}`,
          {
            method: "POST",
            headers: { "Content-Type": contentType, ...authHeaders },
            body: data.body ?? "",
          },
        );
        break;
      }
      case "touch": {
        if (!data.sessionId) {
          throw new Error("touch requires sessionId");
        }
        request = new Request(
          `https://internal/v1/session/${encodeURIComponent(data.sessionId)}/touch`,
          { method: "POST", headers: authHeaders },
        );
        break;
      }
      case "delete": {
        if (!data.sessionId) {
          throw new Error("delete requires sessionId");
        }
        request = new Request(
          `https://internal/v1/session/${encodeURIComponent(data.sessionId)}`,
          { method: "DELETE", headers: authHeaders },
        );
        break;
      }
    }

    const response = await subscription.fetch(request);

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
