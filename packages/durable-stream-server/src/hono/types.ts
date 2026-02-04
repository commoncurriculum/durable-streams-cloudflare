import type { Context } from "hono";
import type { StreamContext } from "../http/context";

export type EdgeEnv = {
  STREAMS: DurableObjectNamespace;
  FANOUT_QUEUE?: Queue;
  AUTH_TOKEN?: string;
  CACHE_MODE?: string;
  READ_JWT_SECRET?: string;
  SESSION_TTL_SECONDS?: string;
  R2?: R2Bucket;
  ADMIN_DB?: D1Database;
  DEBUG_TIMING?: string;
  METRICS?: AnalyticsEngineDataset;
  CF_ACCOUNT_ID?: string;
  METRICS_API_TOKEN?: string;
};

export type EdgeBindings = {
  Bindings: EdgeEnv;
  Variables: {
    timing?: { start: (name: string) => () => void } | null;
  };
};

export type DoBindings = {
  Bindings: Record<string, never>;
  Variables: {
    ctx: StreamContext;
    streamId: string;
  };
};

export type EdgeContext = Context<EdgeBindings>;
export type DoContext = Context<DoBindings>;
