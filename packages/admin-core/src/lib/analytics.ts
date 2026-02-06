import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import type { AnalyticsRow, CoreService } from "../types";

export function parseDoKey(doKey: string): { projectId: string; streamId: string } {
  const i = doKey.indexOf("/");
  if (i === -1) return { projectId: "default", streamId: doKey };
  return { projectId: doKey.slice(0, i), streamId: doKey.slice(i + 1) };
}

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
  .handler(async ({ data: doKey }) => {
    const core = (env as Record<string, unknown>).CORE as CoreService;
    return core.inspectStream(doKey);
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
    const core = (env as Record<string, unknown>).CORE as CoreService;

    const contentType = data.contentType ?? "application/json";
    const method = data.action === "create" ? "PUT" : "POST";

    const response = await core.routeRequest(
      data.streamId,
      new Request("https://internal/v1/stream", {
        method,
        headers: { "Content-Type": contentType },
        body: data.body,
      }),
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

export const getStreamMessages = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: doKey }) => {
    const core = (env as Record<string, unknown>).CORE as CoreService;

    const response = await core.routeRequest(
      doKey,
      new Request("https://internal/v1/stream?offset=0000000000000000_0000000000000000"),
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Stream read failed (${response.status}): ${text}`);
    }

    const nextOffset = response.headers.get("Stream-Next-Offset") ?? null;
    const upToDate = response.headers.get("Stream-Up-To-Date") === "true";
    const contentType = response.headers.get("Content-Type") ?? "";

    let messages: Record<string, {}>[] = [];
    if (contentType.includes("application/json")) {
      const body = await response.json();
      messages = Array.isArray(body) ? body : [body];
    } else {
      const text = await response.text();
      if (text.trim()) {
        messages = [{ _raw: text }];
      }
    }

    return { messages, nextOffset, upToDate };
  });

export const getSseProxyUrl = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: streamId }) => {
    // Return the proxy URL for the client to connect to
    // The actual SSE proxying happens via a server route
    return `/api/sse/${encodeURIComponent(streamId)}`;
  });
