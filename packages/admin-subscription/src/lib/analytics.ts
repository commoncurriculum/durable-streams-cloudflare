import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import type { AnalyticsRow, CoreService, SubscriptionService } from "../types";
import { mintJwt } from "./jwt";

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

function getDatasetName(): string {
  return ((env as Record<string, unknown>).ANALYTICS_DATASET as string | undefined) ?? "subscriptions_metrics";
}

const QUERIES = {
  systemStats: () => `
    SELECT blob3 as event_type, count() as total
    FROM ${getDatasetName()}
    WHERE timestamp > NOW() - INTERVAL '1' HOUR
    GROUP BY blob3
  `,

  activeSessions: () => `
    SELECT blob2 as session_id, max(timestamp) as last_seen, count() as events
    FROM ${getDatasetName()}
    WHERE timestamp > NOW() - INTERVAL '24' HOUR
      AND index1 = 'session'
      AND blob3 IN ('session_create', 'session_touch')
    GROUP BY blob2
    ORDER BY last_seen DESC
    LIMIT 100
  `,

  activeStreams: () => `
    SELECT blob1 as stream_id, min(timestamp) as first_seen, max(timestamp) as last_seen, count() as total_events
    FROM ${getDatasetName()}
    WHERE timestamp > NOW() - INTERVAL '24' HOUR
      AND blob1 != ''
    GROUP BY blob1
    ORDER BY last_seen DESC
    LIMIT 100
  `,

  hotStreams: (limit: number) => `
    SELECT blob1 as stream_id, count() as publishes, sum(double2) as fanout_count
    FROM ${getDatasetName()}
    WHERE timestamp > NOW() - INTERVAL '5' MINUTE
      AND index1 = 'publish'
    GROUP BY blob1
    ORDER BY publishes DESC
    LIMIT ${limit}
  `,

  timeseries: (windowMinutes: number) => `
    SELECT intDiv(toUInt32(timestamp), 60) * 60 as bucket, blob3 as event_type, count() as total
    FROM ${getDatasetName()}
    WHERE timestamp > NOW() - INTERVAL '${windowMinutes}' MINUTE
    GROUP BY bucket, event_type
    ORDER BY bucket
  `,

  fanoutStats: () => `
    SELECT sum(double2) as successes, sum(double3) as failures, avg(double4) as avg_latency_ms, count() as total
    FROM ${getDatasetName()}
    WHERE timestamp > NOW() - INTERVAL '1' HOUR
      AND index1 = 'fanout'
  `,

  cleanupStats: () => `
    SELECT sum(double1) as expired_sessions, sum(double2) as streams_deleted, sum(double3) as subscriptions_removed, count() as batches
    FROM ${getDatasetName()}
    WHERE timestamp > NOW() - INTERVAL '24' HOUR
      AND index1 = 'cleanup'
  `,

  streamSubscribers: (streamId: string) => {
    if (!STREAM_ID_PATTERN.test(streamId)) {
      throw new Error(`Invalid stream ID: ${streamId}`);
    }
    return `
      SELECT blob2 as session_id, sum(double1) as net
      FROM ${getDatasetName()}
      WHERE index1 = 'subscription'
        AND blob1 = '${streamId}'
      GROUP BY blob2
      HAVING net > 0
      ORDER BY session_id
    `;
  },

  publishErrors: () => `
    SELECT blob1 as stream_id, blob4 as error_type, count() as total, max(timestamp) as last_seen
    FROM ${getDatasetName()}
    WHERE timestamp > NOW() - INTERVAL '24' HOUR
      AND index1 = 'publish_error'
    GROUP BY blob1, blob4
    ORDER BY last_seen DESC
    LIMIT 50
  `,
};

export const getStats = createServerFn({ method: "GET" }).handler(async () => {
  const [stats, fanout, cleanup] = await Promise.all([
    queryAnalytics(QUERIES.systemStats()),
    queryAnalytics(QUERIES.fanoutStats()),
    queryAnalytics(QUERIES.cleanupStats()),
  ]);
  return { stats, fanout, cleanup };
});

export const getSessions = createServerFn({ method: "GET" }).handler(
  async () => {
    return queryAnalytics(QUERIES.activeSessions());
  },
);

export const getStreams = createServerFn({ method: "GET" }).handler(
  async () => {
    return queryAnalytics(QUERIES.activeStreams());
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
    return queryAnalytics(QUERIES.publishErrors());
  },
);

export const inspectSession = createServerFn({ method: "GET" })
  .inputValidator((data: { sessionId: string; projectId: string }) => data)
  .handler(async ({ data: { sessionId, projectId } }) => {
    const subscription = (env as Record<string, unknown>).SUBSCRIPTION as SubscriptionService;
    const result = await subscription.adminGetSession(projectId, sessionId);
    if (!result) throw new Error("Session not found");
    return result;
  });

export const inspectStreamSubscribers = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: streamId }) => {
    return queryAnalytics(QUERIES.streamSubscribers(streamId));
  });

export const createProject = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; signingSecret?: string }) => data)
  .handler(async ({ data }) => {
    const projectId = data.projectId.trim();
    if (!projectId) throw new Error("Project ID is required");
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error("Project ID may only contain letters, numbers, hyphens, and underscores");
    const secret = data.signingSecret?.trim() || crypto.randomUUID() + crypto.randomUUID();
    
    // Use core RPC to create the project (no auth needed via service binding)
    const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
    if (!core) throw new Error("CORE service binding is not configured");
    
    await core.registerProject(projectId, secret, { corsOrigins: ["*"] });
    
    return { ok: true, signingSecret: secret };
  });

export const getProjects = createServerFn({ method: "GET" }).handler(async () => {
  const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
  if (!core) return [];
  return core.listProjects();
});

export type StreamMeta = {
  public: boolean;
  content_type: string;
  created_at: number;
};

export const getStreamMeta = createServerFn({ method: "GET" })
  .inputValidator((data: { projectId: string; streamId: string }) => data)
  .handler(async ({ data: { projectId, streamId } }) => {
    const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
    if (!core) return null;
    const doKey = `${projectId}/${streamId}`;
    const metadata = await core.getStreamMetadata(doKey);
    if (!metadata) return null;
    return {
      public: metadata.public,
      content_type: metadata.content_type,
      created_at: metadata.created_at,
    };
  });

export const createSession = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; sessionId: string }) => data)
  .handler(async ({ data: { projectId, sessionId } }) => {
    const subscription = (env as Record<string, unknown>).SUBSCRIPTION as SubscriptionService;
    await subscription.adminTouchSession(projectId, sessionId);

    return { sessionId };
  });

export type SessionListItem = {
  sessionId: string;
  createdAt: number;
};

export const listProjectSessions = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: projectId }): Promise<SessionListItem[]> => {
    const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
    if (!core) return [];
    const streams = await core.listProjectStreams(projectId);
    return streams.map((s) => ({ sessionId: s.streamId, createdAt: s.createdAt }));
  });

export const sendSessionAction = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      action: "subscribe" | "unsubscribe" | "publish" | "touch" | "delete";
      projectId: string;
      sessionId?: string;
      streamId?: string;
      contentType?: string;
      body?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const subscription = (env as Record<string, unknown>).SUBSCRIPTION as SubscriptionService;

    switch (data.action) {
      case "subscribe": {
        if (!data.sessionId || !data.streamId) {
          throw new Error("subscribe requires sessionId and streamId");
        }
        // Ensure the source stream exists on core (PUT is idempotent — creates or no-ops)
        const core = (env as Record<string, unknown>).CORE as CoreService;
        const doKey = `${data.projectId}/${data.streamId}`;
        const putResult = await core.putStream(doKey, { contentType: "application/json" });
        if (!putResult.ok) {
          throw new Error(`Failed to ensure stream exists (${putResult.status}): ${putResult.body}`);
        }
        const result = await subscription.adminSubscribe(data.projectId, data.streamId, data.sessionId);
        return { status: 200, statusText: "OK", body: result };
      }
      case "unsubscribe": {
        if (!data.sessionId || !data.streamId) {
          throw new Error("unsubscribe requires sessionId and streamId");
        }
        const result = await subscription.adminUnsubscribe(data.projectId, data.streamId, data.sessionId);
        return { status: 200, statusText: "OK", body: result };
      }
      case "publish": {
        if (!data.streamId) {
          throw new Error("publish requires streamId");
        }
        if (!data.contentType) {
          throw new Error("publish requires contentType");
        }
        const contentType = data.contentType;
        // Ensure the stream exists on core (PUT is idempotent — creates or no-ops)
        const core = (env as Record<string, unknown>).CORE as CoreService;
        const doKey = `${data.projectId}/${data.streamId}`;
        const putResult = await core.putStream(doKey, { contentType });
        if (!putResult.ok) {
          throw new Error(`Failed to ensure stream exists (${putResult.status}): ${putResult.body}`);
        }
        const payload = new TextEncoder().encode(data.body ?? "");
        const result = await subscription.adminPublish(data.projectId, data.streamId, payload.buffer as ArrayBuffer, contentType) as {
          status: number;
          body?: string;
        };
        if (result.status >= 400) {
          throw new Error(result.body ?? `Publish failed (${result.status})`);
        }
        return { status: result.status, statusText: "OK", body: result };
      }
      case "touch": {
        if (!data.sessionId) {
          throw new Error("touch requires sessionId");
        }
        const result = await subscription.adminTouchSession(data.projectId, data.sessionId);
        return { status: 200, statusText: "OK", body: result };
      }
      case "delete": {
        if (!data.sessionId) {
          throw new Error("delete requires sessionId");
        }
        const result = await subscription.adminDeleteSession(data.projectId, data.sessionId);
        return { status: 200, statusText: "OK", body: result };
      }
    }
  });

// ---------------------------------------------------------------------------
// Core stream URL resolution
// ---------------------------------------------------------------------------

let cachedCoreUrl: string | undefined;

export const getCoreStreamUrl = createServerFn({ method: "GET" }).handler(
  async () => {
    if (cachedCoreUrl) return cachedCoreUrl;

    const coreUrl = (env as Record<string, unknown>).CORE_URL as
      | string
      | undefined;
    if (coreUrl) {
      cachedCoreUrl = coreUrl;
      return cachedCoreUrl;
    }

    // Fallback: resolve via Cloudflare API
    const accountId = (env as Record<string, unknown>).CF_ACCOUNT_ID as
      | string
      | undefined;
    const apiToken = (env as Record<string, unknown>).CF_API_TOKEN as
      | string
      | undefined;

    if (!accountId || !apiToken) {
      throw new Error(
        "CORE_URL or CF_ACCOUNT_ID + CF_API_TOKEN required to resolve core URL",
      );
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
      { headers: { Authorization: `Bearer ${apiToken}` } },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to resolve workers subdomain (${response.status})`,
      );
    }

    const body = (await response.json()) as {
      result?: { subdomain?: string };
    };
    const subdomain = body.result?.subdomain;
    if (!subdomain) {
      throw new Error("Could not resolve workers subdomain");
    }

    cachedCoreUrl = `https://durable-streams.${subdomain}.workers.dev`;
    return cachedCoreUrl;
  },
);

// ---------------------------------------------------------------------------
// JWT minting for browser → core auth
// ---------------------------------------------------------------------------

export const mintStreamToken = createServerFn({ method: "GET" })
  .inputValidator((data: { projectId: string }) => data)
  .handler(async ({ data: { projectId } }) => {
    const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
    if (!core) throw new Error("CORE service binding is not configured");

    // Use RPC to get project config (no auth required via service binding)
    const config = await core.getProjectConfig(projectId);
    if (!config) {
      throw new Error(`Project "${projectId}" not found`);
    }

    const primarySecret = config.signingSecrets[0];
    if (!primarySecret) {
      throw new Error(`No signing secret found for project "${projectId}"`);
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 300; // 5 minutes
    const token = await mintJwt(
      { sub: projectId, scope: "read", iat: now, exp: expiresAt },
      primarySecret,
    );

    return { token, expiresAt };
  });

