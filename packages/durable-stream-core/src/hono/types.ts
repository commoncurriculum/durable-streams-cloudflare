import type { Context } from "hono";
import type { StreamContext } from "../http/context";

export type EdgeEnv = {
  STREAMS: DurableObjectNamespace;
  AUTH_TOKEN?: string;
  CACHE_MODE?: string;
  READ_JWT_SECRET?: string;
  R2?: R2Bucket;
  ADMIN_DB?: D1Database;
  DEBUG_TIMING?: string;
  METRICS?: AnalyticsEngineDataset;
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
