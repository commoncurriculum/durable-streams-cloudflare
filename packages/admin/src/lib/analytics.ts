import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { generateSecret, exportJWK } from "jose";
import {
  getV1Projects,
  getV1ProjectsByProjectIdStreams,
  getV1InspectByStreamPath,
  getV1ConfigByProjectId,
  putV1ConfigByProjectId,
  putV1StreamByStreamPath,
  postV1StreamByStreamPath,
  getV1EstuaryByEstuaryPath,
  postV1EstuarySubscribeByEstuaryPath,
  deleteV1EstuarySubscribeByEstuaryPath,
  deleteV1EstuaryByEstuaryPath,
} from "@durable-streams-cloudflare/estuary-client";
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

// Configure fetch to use server URL
function createFetchOptions(token: string): RequestInit {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Analytics (Cloudflare Analytics Engine)
// ---------------------------------------------------------------------------

export function parseDoKey(doKey: string): { projectId: string; streamId: string } {
  const i = doKey.indexOf("/");
  if (i === -1) return { projectId: "default", streamId: doKey };
  return { projectId: doKey.slice(0, i), streamId: doKey.slice(i + 1) };
}

type AnalyticsRow = Record<string, string | number>;

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

  estuaryList: () => `
    SELECT blob3 as estuary_id, min(timestamp) as first_seen, max(timestamp) as last_seen, count() as events
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

export const getEstuaries = createServerFn({ method: "GET" }).handler(async () => {
  return queryAnalytics(QUERIES.estuaryList());
});

export const getErrors = createServerFn({ method: "GET" }).handler(async () => {
  return queryAnalytics(QUERIES.errors());
});

// ---------------------------------------------------------------------------
// Stream Operations (using generated client)
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

    const token = await getAuthToken("default");

    const bodyBytes = new TextEncoder().encode(data.body);

    if (data.action === "create") {
      await putV1StreamByStreamPath(data.streamId, {
        ...createFetchOptions(token),
        body: bodyBytes,
        headers: {
          ...createFetchOptions(token).headers,
          "Content-Type": data.contentType,
        },
      });
      return { status: 201, statusText: "Created" };
    }

    await postV1StreamByStreamPath(data.streamId, {
      ...createFetchOptions(token),
      body: bodyBytes,
      headers: {
        ...createFetchOptions(token).headers,
        "Content-Type": data.contentType,
      },
    });
    return { status: 200, statusText: "OK" };
  });

// ---------------------------------------------------------------------------
// Project Management (using generated client)
// ---------------------------------------------------------------------------

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

    const token = await getAuthToken(projectId);

    await putV1ConfigByProjectId(projectId, {
      signingSecrets: [secret],
      corsOrigins: [],
      isPublic: false,
    }, createFetchOptions(token));

    return { ok: true, signingSecret: secret };
  });

export const getProjects = createServerFn({ method: "GET" }).handler(async () => {
  const result = await getV1Projects();
  return result.data;
});

export type ProjectListItem = {
  projectId: string;
  isPublic: boolean;
};

export const getProjectsWithConfig = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProjectListItem[]> => {
    const projectsResult = await getV1Projects();
    const projects = projectsResult.data;
    const results: ProjectListItem[] = [];
    
    for (const projectId of projects) {
      try {
        const token = await getAuthToken(projectId);
        const configResult = await getV1ConfigByProjectId(projectId, createFetchOptions(token));
        // Check if it's a success response
        if ("data" in configResult && configResult.status === 200) {
          results.push({ projectId, isPublic: configResult.data.isPublic ?? false });
        } else {
          results.push({ projectId, isPublic: false });
        }
      } catch {
        // Skip projects we can't access
        results.push({ projectId, isPublic: false });
      }
    }
    return results;
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
    const result = await getV1ProjectsByProjectIdStreams(projectId);
    const streams = result.data;
    
    return streams.map((s: { streamId: string; createdAt: number }) => ({
      stream_id: s.streamId,
      messages: 0,
      bytes: 0,
      last_seen: new Date(s.createdAt).toISOString(),
    }));
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
    const token = await getAuthToken(projectId);
    const result = await getV1ConfigByProjectId(projectId, createFetchOptions(token));
    
    if (result.status !== 200) {
      throw new Error(`Failed to get config: ${result.status}`);
    }

    return {
      signingSecrets: result.data.signingSecrets,
      corsOrigins: result.data.corsOrigins ?? [],
      isPublic: result.data.isPublic ?? false,
    };
  });

export const updateProjectPrivacy = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; isPublic: boolean }) => data)
  .handler(async ({ data }) => {
    const token = await getAuthToken(data.projectId);

    const currentConfig = await getProjectConfig({ data: data.projectId });

    await putV1ConfigByProjectId(
      data.projectId,
      {
        signingSecrets: currentConfig.signingSecrets,
        corsOrigins: currentConfig.corsOrigins,
        isPublic: data.isPublic,
      },
      createFetchOptions(token),
    );

    return { ok: true };
  });

export const addCorsOrigin = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; origin: string }) => data)
  .handler(async ({ data }) => {
    const token = await getAuthToken(data.projectId);

    const currentConfig = await getProjectConfig({ data: data.projectId });
    const updatedOrigins = [...currentConfig.corsOrigins, data.origin];

    await putV1ConfigByProjectId(
      data.projectId,
      {
        signingSecrets: currentConfig.signingSecrets,
        corsOrigins: updatedOrigins,
        isPublic: currentConfig.isPublic,
      },
      createFetchOptions(token),
    );

    return { ok: true };
  });

export const removeCorsOrigin = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; origin: string }) => data)
  .handler(async ({ data }) => {
    const token = await getAuthToken(data.projectId);

    const currentConfig = await getProjectConfig({ data: data.projectId });
    const updatedOrigins = currentConfig.corsOrigins.filter((o) => o !== data.origin);

    await putV1ConfigByProjectId(
      data.projectId,
      {
        signingSecrets: currentConfig.signingSecrets,
        corsOrigins: updatedOrigins,
        isPublic: currentConfig.isPublic,
      },
      createFetchOptions(token),
    );

    return { ok: true };
  });

export const generateSigningKey = createServerFn({ method: "POST" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: projectId }) => {
    const token = await getAuthToken(projectId);

    const newSecret = JSON.stringify(
      await exportJWK(await generateSecret("HS256", { extractable: true })),
    );

    const currentConfig = await getProjectConfig({ data: projectId });
    const updatedSecrets = [...currentConfig.signingSecrets, newSecret];

    await putV1ConfigByProjectId(
      projectId,
      {
        signingSecrets: updatedSecrets,
        corsOrigins: currentConfig.corsOrigins,
        isPublic: currentConfig.isPublic,
      },
      createFetchOptions(token),
    );

    return { keyCount: updatedSecrets.length, secret: newSecret };
  });

export const revokeSigningKey = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; secret: string }) => data)
  .handler(async ({ data }) => {
    const token = await getAuthToken(data.projectId);

    const currentConfig = await getProjectConfig({ data: data.projectId });
    const updatedSecrets = currentConfig.signingSecrets.filter((s) => s !== data.secret);

    if (updatedSecrets.length === 0) {
      throw new Error("Cannot revoke the last signing key");
    }

    await putV1ConfigByProjectId(
      data.projectId,
      {
        signingSecrets: updatedSecrets,
        corsOrigins: currentConfig.corsOrigins,
        isPublic: currentConfig.isPublic,
      },
      createFetchOptions(token),
    );

    return { keyCount: updatedSecrets.length };
  });

// ---------------------------------------------------------------------------
// Stream Inspection (using generated client)
// ---------------------------------------------------------------------------

export const inspectStream = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: streamId }) => {
    const result = await getV1InspectByStreamPath(streamId);
    if (result.status === 200) {
      return result.data;
    }
    throw new Error("Stream not found");
  });

export const getStreamMeta = createServerFn({ method: "GET" })
  .inputValidator((data: { projectId: string; streamId: string }) => data)
  .handler(async ({ data }) => {
    const doKey = `${data.projectId}/${data.streamId}`;
    const result = await getV1InspectByStreamPath(doKey);
    if (result.status === 200) {
      return result.data;
    }
    throw new Error("Stream not found");
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
    const expiresAt = now + 300; // 5 minutes
    return { token, expiresAt };
  });

// ---------------------------------------------------------------------------
// Estuary Management (using generated client)
// ---------------------------------------------------------------------------

export const inspectEstuary = createServerFn({ method: "GET" })
  .inputValidator((data: { estuaryId: string; projectId: string }) => data)
  .handler(async ({ data }) => {
    const estuaryPath = `${data.projectId}/${data.estuaryId}`;
    const result = await getV1EstuaryByEstuaryPath(estuaryPath);
    return result.data;
  });

export const inspectStreamSubscribers = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: streamId }) => {
    // TODO: Need endpoint to list subscribers of a stream
    return [] as object[];
  });

export const listProjectEstuaries = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(
    async ({ data: projectId }): Promise<Array<{ estuaryId: string; createdAt?: string }>> => {
      // For now, return empty - need proper estuary listing endpoint
      return [];
    },
  );

export const createEstuary = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; estuaryId: string }) => data)
  .handler(async ({ data: { projectId, estuaryId } }): Promise<{ estuaryId: string }> => {
    // Create the estuary stream
    const token = await getAuthToken(projectId);
    const estuaryPath = `${projectId}/${estuaryId}`;

    await putV1StreamByStreamPath(
      estuaryPath,
      {
        ...createFetchOptions(token),
        headers: {
          ...createFetchOptions(token).headers,
          "Content-Type": "application/json",
        },
        body: new Uint8Array(),
      },
    );

    return { estuaryId };
  });

export const sendEstuaryAction = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      action: "subscribe" | "unsubscribe" | "publish" | "delete";
      projectId: string;
      estuaryId?: string;
      streamId?: string;
      contentType?: string;
      body?: string;
    }) => data,
  )
  .handler(async ({ data }) => {
    const token = await getAuthToken(data.projectId);

    switch (data.action) {
      case "subscribe": {
        if (!data.estuaryId || !data.streamId) {
          throw new Error("subscribe requires estuaryId and streamId");
        }
        const sourceStreamPath = `${data.projectId}/${data.streamId}`;
        const estuaryId = data.estuaryId;
        
        // Subscribe: POST /v1/estuary/subscribe/:sourceStreamPath with body { estuaryId }
        const result = await postV1EstuarySubscribeByEstuaryPath(
          sourceStreamPath,
          { estuaryId },
          createFetchOptions(token),
        );
        return { status: 200, statusText: "OK", body: result.data };
      }

      case "unsubscribe": {
        if (!data.estuaryId || !data.streamId) {
          throw new Error("unsubscribe requires estuaryId and streamId");
        }
        const sourceStreamPath = `${data.projectId}/${data.streamId}`;
        const estuaryId = data.estuaryId;

        const result = await deleteV1EstuarySubscribeByEstuaryPath(
          sourceStreamPath,
          { estuaryId },
          createFetchOptions(token),
        );
        return { status: 200, statusText: "OK", body: result.data };
      }

      case "publish": {
        if (!data.streamId || !data.contentType || !data.body) {
          throw new Error("publish requires streamId, contentType, and body");
        }
        const streamPath = `${data.projectId}/${data.streamId}`;
        const bodyBytes = new TextEncoder().encode(data.body);

        await postV1StreamByStreamPath(streamPath, {
          ...createFetchOptions(token),
          body: bodyBytes,
          headers: {
            ...createFetchOptions(token).headers,
            "Content-Type": data.contentType,
          },
        });
        return { status: 200, statusText: "OK", body: {} };
      }

      case "delete": {
        if (!data.estuaryId) {
          throw new Error("delete requires estuaryId");
        }
        const estuaryPath = `${data.projectId}/${data.estuaryId}`;

        await deleteV1EstuaryByEstuaryPath(estuaryPath, createFetchOptions(token));
        return { status: 200, statusText: "OK", body: {} };
      }

      default:
        throw new Error(`Unknown action: ${data.action}`);
    }
  });
