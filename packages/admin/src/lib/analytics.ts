import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { generateSecret, exportJWK } from "jose";
import { mintJwt } from "./jwt";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getServerUrl(): string {
  const url = (env as Record<string, unknown>).SERVER_URL as string | undefined;
  if (!url) {
    throw new Error("SERVER_URL environment variable is required");
  }
  return url;
}

function getAdminSecret(): string {
  const secret = (env as Record<string, unknown>).ADMIN_SECRET as string | undefined;
  if (!secret) {
    throw new Error("ADMIN_SECRET environment variable is required");
  }
  return secret;
}

// Get auth token for admin requests
async function getAuthToken(projectId: string): Promise<string> {
  return mintJwt({ projectId }, getAdminSecret());
}

// ---------------------------------------------------------------------------
// Analytics (Cloudflare Analytics Engine)
// ---------------------------------------------------------------------------

export function parseDoKey(doKey: string): { projectId: string; streamId: string } {
  const i = doKey.indexOf("/");
  if (i === -1) return { projectId: "default", streamId: doKey };
  return { projectId: doKey.slice(0, i), streamId: doKey.slice(i + 1) };
}

async function queryAnalytics(sql: string): Promise<AnalyticsRow[]> {
  const accountId = (env as Record<string, unknown>).CF_ACCOUNT_ID as string | undefined;
  const apiToken = (env as Record<string, unknown>).CF_API_TOKEN as string | undefined;

  if (!accountId || !apiToken) {
    throw new Error("CF_ACCOUNT_ID and CF_API_TOKEN are required for analytics queries");
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
    throw new Error(`Analytics Engine query failed (${response.status}): ${text}`);
  }

  const body = (await response.json()) as { data?: AnalyticsRow[] };
  return body.data ?? [];
}

function getDatasetName(): string {
  return (
    ((env as Record<string, unknown>).ANALYTICS_DATASET as string | undefined) ??
    "durable_streams_metrics"
  );
}

type AnalyticsRow = Record<string, string | number>;

const QUERIES = {
  systemStats: () => `
    SELECT blob2 as event_type, count() as total, sum(double2) as total_bytes
    FROM ${getDatasetName()}
    WHERE timestamp > NOW() - INTERVAL '1' HOUR
    GROUP BY blob2
  `,

  streamList: () => `
    SELECT blob1 as stream_id, min(timestamp) as first_seen, max(timestamp) as last_seen, count() as total_events
    FROM ${getDatasetName()}
    WHERE timestamp > NOW() - INTERVAL '24' HOUR AND blob2 != 'read'
    GROUP BY blob1
    ORDER BY last_seen DESC
    LIMIT 100
  `,

  hotStreams: (limit: number) => `
    SELECT blob1 as stream_id, count() as events, sum(double2) as bytes
    FROM ${getDatasetName()}
    WHERE timestamp > NOW() - INTERVAL '5' MINUTE AND blob2 = 'append'
    GROUP BY blob1
    ORDER BY events DESC
    LIMIT ${limit}
  `,

  timeseries: (windowMinutes: number) => `
    SELECT intDiv(toUInt32(timestamp), 60) * 60 as bucket, blob2 as event_type, count() as total, sum(double2) as bytes
    FROM ${getDatasetName()}
    WHERE timestamp > NOW() - INTERVAL '${windowMinutes}' MINUTE
    GROUP BY bucket, event_type
    ORDER BY bucket
  `,

  sessionList: () => `
    SELECT blob3 as session_id, min(timestamp) as first_seen, max(timestamp) as last_seen, count() as events
    FROM ${getDatasetName()}
    WHERE timestamp > NOW() - INTERVAL '24' HOUR AND blob2 IN ('subscribe', 'unsubscribe', 'publish')
    GROUP BY blob3
    ORDER BY last_seen DESC
    LIMIT 100
  `,

  errors: () => `
    SELECT blob1 as stream_id, blob2 as event_type, blob3 as error_code, timestamp, double1 as status_code
    FROM ${getDatasetName()}
    WHERE timestamp > NOW() - INTERVAL '1' HOUR AND double1 >= 400
    ORDER BY timestamp DESC
    LIMIT 100
  `,
};

export const getStats = createServerFn({ method: "GET" }).handler(async () => {
  return queryAnalytics(QUERIES.systemStats());
});

export const getStreams = createServerFn({ method: "GET" }).handler(async () => {
  return queryAnalytics(QUERIES.streamList());
});

export const getHotStreams = createServerFn({ method: "GET" }).handler(async () => {
  return queryAnalytics(QUERIES.hotStreams(20));
});

export const getTimeseries = createServerFn({ method: "GET" }).handler(async () => {
  return queryAnalytics(QUERIES.timeseries(60));
});

export const getSessions = createServerFn({ method: "GET" }).handler(async () => {
  return queryAnalytics(QUERIES.sessionList());
});

export const getErrors = createServerFn({ method: "GET" }).handler(async () => {
  return queryAnalytics(QUERIES.errors());
});

// ---------------------------------------------------------------------------
// Stream Operations (using estuary-client)
// ---------------------------------------------------------------------------

export const sendTestAction = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { streamId: string; action: "create" | "append"; contentType?: string; body: string }) =>
      data,
  )
  .handler(async ({ data }) => {
    if (!data.contentType) {
      throw new Error("contentType is required");
    }
    const contentType = data.contentType;
    const bodyBytes = new TextEncoder().encode(data.body);

    const serverUrl = getServerUrl();
    const token = await getAuthToken("default");

    const url =
      data.action === "create"
        ? `${serverUrl}/v1/stream/${data.streamId}`
        : `${serverUrl}/v1/stream/${data.streamId}`;
    const method = data.action === "create" ? "PUT" : "POST";

    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": contentType,
        Authorization: `Bearer ${token}`,
      },
      body: bodyBytes,
    });

    return {
      status: response.status,
      statusText: response.statusText || (response.ok ? "OK" : "Error"),
    };
  });

// ---------------------------------------------------------------------------
// Project Management
// ---------------------------------------------------------------------------

// NOTE: These operations are NOT available in estuary-client yet.
// They are RPC methods on the CoreService binding that aren't exposed as HTTP endpoints.
// For now, returning placeholder responses.

export const createProject = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; signingSecret?: string }) => data)
  .handler(async ({ data }) => {
    const projectId = data.projectId.trim();
    if (!projectId) throw new Error("Project ID is required");
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId))
      throw new Error("Project ID may only contain letters, numbers, hyphens, and underscores");
    const secret =
      data.signingSecret?.trim() ||
      JSON.stringify(await exportJWK(await generateSecret("HS256", { extractable: true })));

    // TODO: This needs to be implemented in the server as an HTTP endpoint
    // For now, we create a config with the signing secret
    const serverUrl = getServerUrl();
    const token = await getAuthToken(projectId);

    const response = await fetch(`${serverUrl}/v1/config/${projectId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        signingSecrets: [secret],
        corsOrigins: [],
        isPublic: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create project: ${response.status} ${response.statusText}`);
    }

    return { ok: true, signingSecret: secret };
  });

export const getProjects = createServerFn({ method: "GET" }).handler(async () => {
  // TODO: This needs a server endpoint like GET /v1/projects
  // For now, return empty array
  return [];
});

export type ProjectListItem = {
  projectId: string;
  isPublic: boolean;
};

export const getProjectsWithConfig = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProjectListItem[]> => {
    // TODO: This needs a server endpoint like GET /v1/projects
    // For now, return empty array
    return [];
  },
);

export type ProjectStreamRow = {
  stream_id: string;
  messages: number;
  bytes: number;
  last_seen: string;
};

export const getProjectStreams = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: projectId }): Promise<ProjectStreamRow[]> => {
    // TODO: This needs a server endpoint like GET /v1/projects/:projectId/streams
    // For now, return empty array
    return [];
  });

export type StreamTimeseriesRow = {
  bucket: number;
  messages: number;
  bytes: number;
};

export const getStreamTimeseries = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: doKey }): Promise<StreamTimeseriesRow[]> => {
    const accountId = (env as Record<string, unknown>).CF_ACCOUNT_ID as string | undefined;
    const apiToken = (env as Record<string, unknown>).CF_API_TOKEN as string | undefined;
    if (!accountId || !apiToken) return [];
    try {
      const rows = await queryAnalytics(`
        SELECT intDiv(toUInt32(timestamp), 60) * 60 as bucket, count() as messages, sum(double2) as bytes
        FROM ${getDatasetName()}
        WHERE blob1 = '${doKey}' AND blob2 = 'append'
          AND timestamp > NOW() - INTERVAL '60' MINUTE
        GROUP BY bucket
        ORDER BY bucket
      `);
      return rows.map((r) => ({
        bucket: Number(r.bucket),
        messages: Number(r.messages),
        bytes: Number(r.bytes),
      }));
    } catch {
      return [];
    }
  });

export interface ProjectConfig {
  signingSecrets: string[];
  corsOrigins: string[];
  isPublic: boolean;
}

export const getProjectConfig = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: projectId }): Promise<ProjectConfig> => {
    const serverUrl = getServerUrl();
    const token = await getAuthToken(projectId);

    const response = await fetch(`${serverUrl}/v1/config/${projectId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get project config: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      signingSecrets: string[];
      corsOrigins?: string[];
      isPublic?: boolean;
    };
    return {
      signingSecrets: data.signingSecrets,
      corsOrigins: data.corsOrigins ?? [],
      isPublic: data.isPublic ?? false,
    };
  });

export const updateProjectPrivacy = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; isPublic: boolean }) => data)
  .handler(async ({ data }) => {
    const serverUrl = getServerUrl();
    const token = await getAuthToken(data.projectId);

    // Get current config first
    const currentConfig = await getProjectConfig({ data: data.projectId });

    // Update with new privacy setting
    const response = await fetch(`${serverUrl}/v1/config/${data.projectId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        signingSecrets: currentConfig.signingSecrets,
        corsOrigins: currentConfig.corsOrigins,
        isPublic: data.isPublic,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to update project privacy: ${response.status} ${response.statusText}`,
      );
    }

    return { ok: true };
  });

export const addCorsOrigin = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; origin: string }) => data)
  .handler(async ({ data }) => {
    const serverUrl = getServerUrl();
    const token = await getAuthToken(data.projectId);

    // Get current config first
    const currentConfig = await getProjectConfig({ data: data.projectId });

    // Add new origin
    const updatedOrigins = [...currentConfig.corsOrigins, data.origin];

    const response = await fetch(`${serverUrl}/v1/config/${data.projectId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        signingSecrets: currentConfig.signingSecrets,
        corsOrigins: updatedOrigins,
        isPublic: currentConfig.isPublic,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to add CORS origin: ${response.status} ${response.statusText}`);
    }

    return { ok: true };
  });

export const removeCorsOrigin = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; origin: string }) => data)
  .handler(async ({ data }) => {
    const serverUrl = getServerUrl();
    const token = await getAuthToken(data.projectId);

    // Get current config first
    const currentConfig = await getProjectConfig({ data: data.projectId });

    // Remove origin
    const updatedOrigins = currentConfig.corsOrigins.filter((o) => o !== data.origin);

    const response = await fetch(`${serverUrl}/v1/config/${data.projectId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        signingSecrets: currentConfig.signingSecrets,
        corsOrigins: updatedOrigins,
        isPublic: currentConfig.isPublic,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to remove CORS origin: ${response.status} ${response.statusText}`);
    }

    return { ok: true };
  });

export const generateSigningKey = createServerFn({ method: "POST" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: projectId }) => {
    const serverUrl = getServerUrl();
    const token = await getAuthToken(projectId);

    const newSecret = JSON.stringify(
      await exportJWK(await generateSecret("HS256", { extractable: true })),
    );

    // Get current config first
    const currentConfig = await getProjectConfig({ data: projectId });

    // Add new signing key
    const updatedSecrets = [...currentConfig.signingSecrets, newSecret];

    const response = await fetch(`${serverUrl}/v1/config/${projectId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        signingSecrets: updatedSecrets,
        corsOrigins: currentConfig.corsOrigins,
        isPublic: currentConfig.isPublic,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to generate signing key: ${response.status} ${response.statusText}`,
      );
    }

    return { keyCount: updatedSecrets.length, secret: newSecret };
  });

export const revokeSigningKey = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; secret: string }) => data)
  .handler(async ({ data }) => {
    const serverUrl = getServerUrl();
    const token = await getAuthToken(data.projectId);

    // Get current config first
    const currentConfig = await getProjectConfig({ data: data.projectId });

    // Remove signing key
    const updatedSecrets = currentConfig.signingSecrets.filter((s) => s !== data.secret);

    if (updatedSecrets.length === 0) {
      throw new Error("Cannot revoke the last signing key");
    }

    const response = await fetch(`${serverUrl}/v1/config/${data.projectId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        signingSecrets: updatedSecrets,
        corsOrigins: currentConfig.corsOrigins,
        isPublic: currentConfig.isPublic,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to revoke signing key: ${response.status} ${response.statusText}`);
    }

    return { keyCount: updatedSecrets.length };
  });

// ---------------------------------------------------------------------------
// Stream inspection (NOT in estuary-client yet)
// ---------------------------------------------------------------------------

export const inspectStream = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: doKey }) => {
    // TODO: This needs a server endpoint like GET /v1/inspect/stream/:streamId
    // For now, throw error
    throw new Error(
      "Stream inspection not available via HTTP API yet. This feature requires server-side RPC methods.",
    );
  });

// ---------------------------------------------------------------------------
// Server URL resolution
// ---------------------------------------------------------------------------

let cachedServerUrl: string | undefined;

export const getCoreStreamUrl = createServerFn({ method: "GET" }).handler(async () => {
  if (cachedServerUrl) return cachedServerUrl;

  cachedServerUrl = getServerUrl();
  return cachedServerUrl;
});

export const mintStreamToken = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string }) => data)
  .handler(async ({ data }) => {
    const token = await getAuthToken(data.projectId);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 300; // 5 minutes (match token expiry)
    return { token, expiresAt };
  });

// ---------------------------------------------------------------------------
// Session inspection (subscription-specific, NOT in estuary-client yet)
// ---------------------------------------------------------------------------

export const inspectSession = createServerFn({ method: "GET" })
  .inputValidator((data: { sessionId: string; projectId: string }) => data)
  .handler(async ({ data }) => {
    // TODO: This needs a server endpoint like GET /v1/sessions/:sessionId
    throw new Error(
      "Session inspection not available via HTTP API yet. This feature requires server-side RPC methods.",
    );
    // eslint-disable-next-line no-unreachable
    return { sessionId: data.sessionId, streamSubscriptions: [] as object[] };
  });

export const inspectStreamSubscribers = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: streamId }) => {
    // TODO: This needs a server endpoint like GET /v1/streams/:streamId/subscribers
    throw new Error(
      "Stream subscriber inspection not available via HTTP API yet. This feature requires server-side RPC methods.",
    );
    // eslint-disable-next-line no-unreachable
    return [] as object[];
  });

export const getStreamMeta = createServerFn({ method: "GET" })
  .inputValidator((data: { projectId: string; streamId: string }) => data)
  .handler(async ({ data }): Promise<{ offset: number; contentType: string }> => {
    // TODO: This needs a server endpoint like GET /v1/streams/:streamId/meta
    throw new Error(
      "Stream metadata not available via HTTP API yet. This feature requires server-side RPC methods.",
    );
  });

export const listProjectSessions = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(
    async ({ data: projectId }): Promise<Array<{ sessionId: string; createdAt?: string }>> => {
      // TODO: This needs a server endpoint like GET /v1/projects/:projectId/sessions
      return [];
    },
  );

// ---------------------------------------------------------------------------
// Session Management (subscription-specific, NOT in estuary-client yet)
// ---------------------------------------------------------------------------

export const createSession = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; sessionId: string }) => data)
  .handler(async ({ data: { projectId, sessionId } }): Promise<{ sessionId: string }> => {
    // TODO: This needs a server endpoint like POST /v1/sessions
    throw new Error(
      "Session creation not available via HTTP API yet. This feature requires server-side RPC methods.",
    );
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
  .handler(
    async ({ data }): Promise<{ status: number; statusText: string; body?: object }> => {
      // TODO: These need server endpoints for subscription operations
      throw new Error(
        "Session actions not available via HTTP API yet. This feature requires server-side RPC methods.",
      );
    },
  );
