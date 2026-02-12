import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { generateSecret, exportJWK } from "jose";
import type { AnalyticsRow, CoreService } from "../types";
import { mintJwt } from "./jwt";

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

export const inspectStream = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: doKey }) => {
    const core = (env as Record<string, unknown>).CORE as CoreService;
    const result = await core.inspectStream(doKey);
    if (!result) throw new Error("Stream not found");
    return result;
  });

export const sendTestAction = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { streamId: string; action: "create" | "append"; contentType?: string; body: string }) =>
      data,
  )
  .handler(async ({ data }) => {
    const core = (env as Record<string, unknown>).CORE as CoreService;

    if (!data.contentType) {
      throw new Error("contentType is required");
    }
    const contentType = data.contentType;
    const bodyBytes = new TextEncoder().encode(data.body);

    if (data.action === "create") {
      const result = await core.putStream(data.streamId, {
        body: bodyBytes.buffer as ArrayBuffer,
        contentType,
      });
      return {
        status: result.status,
        statusText: result.ok ? "OK" : "Error",
      };
    }

    const result = await core.postStream(
      data.streamId,
      bodyBytes.buffer as ArrayBuffer,
      contentType,
    );
    return {
      status: result.status,
      statusText: result.ok ? "OK" : "Error",
    };
  });

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

    const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
    if (!core) throw new Error("CORE service binding is not configured");

    await core.registerProject(projectId, secret);
    return { ok: true, signingSecret: secret };
  });

export const getProjects = createServerFn({ method: "GET" }).handler(async () => {
  const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
  if (!core) return [];
  return core.listProjects();
});

export type ProjectListItem = {
  projectId: string;
  isPublic: boolean;
};

export const getProjectsWithConfig = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProjectListItem[]> => {
    const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
    if (!core) return [];
    const projectIds = await core.listProjects();
    const results: ProjectListItem[] = [];
    for (const projectId of projectIds) {
      const config = await core.getProjectConfig(projectId);
      results.push({ projectId, isPublic: config?.isPublic ?? false });
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
    const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
    if (!core) return [];
    try {
      const streams = await core.listProjectStreams(projectId);
      return streams.map((s) => ({
        stream_id: s.streamId,
        messages: 0,
        bytes: 0,
        last_seen: new Date(s.createdAt).toISOString(),
      }));
    } catch {
      return [];
    }
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
    const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
    if (!core) throw new Error("CORE service binding is not configured");

    const config = await core.getProjectConfig(projectId);
    if (!config) throw new Error("Project not found");

    return {
      signingSecrets: config.signingSecrets,
      corsOrigins: config.corsOrigins ?? [],
      isPublic: config.isPublic ?? false,
    };
  });

export const updateProjectPrivacy = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; isPublic: boolean }) => data)
  .handler(async ({ data }) => {
    const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
    if (!core) throw new Error("CORE service binding is not configured");

    await core.updatePrivacy(data.projectId, data.isPublic);
    return { ok: true };
  });

export const addCorsOrigin = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; origin: string }) => data)
  .handler(async ({ data }) => {
    const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
    if (!core) throw new Error("CORE service binding is not configured");

    await core.addCorsOrigin(data.projectId, data.origin);
    return { ok: true };
  });

export const removeCorsOrigin = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; origin: string }) => data)
  .handler(async ({ data }) => {
    const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
    if (!core) throw new Error("CORE service binding is not configured");

    await core.removeCorsOrigin(data.projectId, data.origin);
    return { ok: true };
  });

export const generateSigningKey = createServerFn({ method: "POST" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: projectId }) => {
    const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
    if (!core) throw new Error("CORE service binding is not configured");

    const newSecret = JSON.stringify(
      await exportJWK(await generateSecret("HS256", { extractable: true })),
    );
    const result = await core.addSigningKey(projectId, newSecret);
    return { keyCount: result.keyCount, secret: newSecret };
  });

export const revokeSigningKey = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; secret: string }) => data)
  .handler(async ({ data }) => {
    const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
    if (!core) throw new Error("CORE service binding is not configured");

    const result = await core.removeSigningKey(data.projectId, data.secret);
    return { keyCount: result.keyCount };
  });

// ---------------------------------------------------------------------------
// Core stream URL resolution
// ---------------------------------------------------------------------------

let cachedCoreUrl: string | undefined;

export const getCoreStreamUrl = createServerFn({ method: "GET" }).handler(async () => {
  if (cachedCoreUrl) return cachedCoreUrl;

  const coreUrl = (env as Record<string, unknown>).CORE_URL as string | undefined;
  if (coreUrl) {
    cachedCoreUrl = coreUrl;
    return cachedCoreUrl;
  }

  // Fallback: resolve via Cloudflare API
  const accountId = (env as Record<string, unknown>).CF_ACCOUNT_ID as string | undefined;
  const apiToken = (env as Record<string, unknown>).CF_API_TOKEN as string | undefined;

  if (!accountId || !apiToken) {
    throw new Error(
      'CORE_URL is not set. Add CORE_URL to your wrangler.toml [vars] (e.g. CORE_URL = "https://durable-streams.your-subdomain.workers.dev") or set CF_ACCOUNT_ID + CF_API_TOKEN for auto-resolution.',
    );
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
    { headers: { Authorization: `Bearer ${apiToken}` } },
  );

  if (!response.ok) {
    throw new Error(`Failed to resolve workers subdomain (${response.status})`);
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
});

// ---------------------------------------------------------------------------
// JWT minting for browser → core auth
// ---------------------------------------------------------------------------

export const mintStreamToken = createServerFn({ method: "GET" })
  .inputValidator((data: { projectId: string }) => data)
  .handler(async ({ data: { projectId } }) => {
    const core = (env as Record<string, unknown>).CORE as CoreService | undefined;
    if (!core) throw new Error("CORE service binding is not configured");

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
