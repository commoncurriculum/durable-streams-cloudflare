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

function getDatasetName(): string {
  return ((env as Record<string, unknown>).ANALYTICS_DATASET as string | undefined) ?? "durable_streams_metrics";
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

export const getStreams = createServerFn({ method: "GET" }).handler(
  async () => {
    return queryAnalytics(QUERIES.streamList());
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
    const result = await core.inspectStream(doKey);
    if (!result) throw new Error("Stream not found");
    return result;
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

export const getStreamMessages = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: doKey }) => {
    const core = (env as Record<string, unknown>).CORE as CoreService;

    const result = await core.readStream(doKey, "0000000000000000_0000000000000000");

    if (!result.ok) {
      throw new Error(`Stream read failed (${result.status}): ${result.body}`);
    }

    let messages: Record<string, {}>[] = [];
    if (result.contentType.includes("application/json")) {
      const parsed = JSON.parse(result.body);
      messages = Array.isArray(parsed) ? parsed : [parsed];
    } else {
      if (result.body.trim()) {
        messages = [{ _raw: result.body }];
      }
    }

    return { messages, nextOffset: result.nextOffset, upToDate: result.upToDate };
  });

export const createProject = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; signingSecret?: string }) => data)
  .handler(async ({ data }) => {
    const kv = (env as Record<string, unknown>).REGISTRY as KVNamespace | undefined;
    if (!kv) throw new Error("REGISTRY KV namespace is not configured");
    const projectId = data.projectId.trim();
    if (!projectId) throw new Error("Project ID is required");
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error("Project ID may only contain letters, numbers, hyphens, and underscores");
    const secret = data.signingSecret?.trim() || crypto.randomUUID() + crypto.randomUUID();
    await kv.put(projectId, JSON.stringify({ signingSecrets: [secret] }));
    return { ok: true, signingSecret: secret };
  });

export const getProjects = createServerFn({ method: "GET" }).handler(async () => {
  const kv = (env as Record<string, unknown>).REGISTRY as KVNamespace | undefined;
  if (!kv) return [];
  const list = await kv.list();
  return list.keys.map((k) => k.name).filter((name) => !name.includes("/")).sort();
});

export interface ProjectConfig {
  signingSecrets: string[];
  corsOrigins: string[];
  isPublic: boolean;
}

export const getProjectConfig = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: projectId }): Promise<ProjectConfig> => {
    const kv = (env as Record<string, unknown>).REGISTRY as KVNamespace | undefined;
    if (!kv) throw new Error("REGISTRY KV namespace is not configured");
    const raw = await kv.get(projectId);
    if (!raw) throw new Error("Project not found");
    const config = JSON.parse(raw) as Partial<ProjectConfig>;
    return {
      signingSecrets: config.signingSecrets ?? [],
      corsOrigins: config.corsOrigins ?? [],
      isPublic: config.isPublic ?? false,
    };
  });

export const updateProjectPrivacy = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; isPublic: boolean }) => data)
  .handler(async ({ data }) => {
    const kv = (env as Record<string, unknown>).REGISTRY as KVNamespace | undefined;
    if (!kv) throw new Error("REGISTRY KV namespace is not configured");
    const raw = await kv.get(data.projectId);
    if (!raw) throw new Error("Project not found");
    const config = JSON.parse(raw);
    config.isPublic = data.isPublic;
    await kv.put(data.projectId, JSON.stringify(config));
    return { ok: true };
  });

export const addCorsOrigin = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; origin: string }) => data)
  .handler(async ({ data }) => {
    const kv = (env as Record<string, unknown>).REGISTRY as KVNamespace | undefined;
    if (!kv) throw new Error("REGISTRY KV namespace is not configured");
    const raw = await kv.get(data.projectId);
    if (!raw) throw new Error("Project not found");
    const config = JSON.parse(raw);
    const origins: string[] = config.corsOrigins ?? [];
    if (!origins.includes(data.origin)) {
      origins.push(data.origin);
    }
    config.corsOrigins = origins;
    await kv.put(data.projectId, JSON.stringify(config));
    return { ok: true };
  });

export const removeCorsOrigin = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; origin: string }) => data)
  .handler(async ({ data }) => {
    const kv = (env as Record<string, unknown>).REGISTRY as KVNamespace | undefined;
    if (!kv) throw new Error("REGISTRY KV namespace is not configured");
    const raw = await kv.get(data.projectId);
    if (!raw) throw new Error("Project not found");
    const config = JSON.parse(raw);
    const origins: string[] = config.corsOrigins ?? [];
    config.corsOrigins = origins.filter((o: string) => o !== data.origin);
    await kv.put(data.projectId, JSON.stringify(config));
    return { ok: true };
  });

export const generateSigningKey = createServerFn({ method: "POST" })
  .inputValidator((data: string) => data)
  .handler(async ({ data: projectId }) => {
    const kv = (env as Record<string, unknown>).REGISTRY as KVNamespace | undefined;
    if (!kv) throw new Error("REGISTRY KV namespace is not configured");
    const raw = await kv.get(projectId);
    if (!raw) throw new Error("Project not found");
    const config = JSON.parse(raw);
    const newSecret = crypto.randomUUID() + crypto.randomUUID();
    const secrets: string[] = config.signingSecrets ?? [];
    secrets.unshift(newSecret);
    config.signingSecrets = secrets;
    await kv.put(projectId, JSON.stringify(config));
    return { keyCount: secrets.length, secret: newSecret };
  });

export const revokeSigningKey = createServerFn({ method: "POST" })
  .inputValidator((data: { projectId: string; secret: string }) => data)
  .handler(async ({ data }) => {
    const kv = (env as Record<string, unknown>).REGISTRY as KVNamespace | undefined;
    if (!kv) throw new Error("REGISTRY KV namespace is not configured");
    const raw = await kv.get(data.projectId);
    if (!raw) throw new Error("Project not found");
    const config = JSON.parse(raw);
    const secrets: string[] = config.signingSecrets ?? [];
    const filtered = secrets.filter((s: string) => s !== data.secret);
    if (filtered.length === 0) throw new Error("Cannot remove the last signing key");
    config.signingSecrets = filtered;
    await kv.put(data.projectId, JSON.stringify(config));
    return { keyCount: filtered.length };
  });
