import type { SubscriptionDO } from "./subscriptions/do";
import type { CoreClientEnv } from "./client";
import type { AnalyticsQueryEnv } from "./analytics";

export interface AppEnv extends CoreClientEnv, Partial<AnalyticsQueryEnv> {
  SUBSCRIPTION_DO: DurableObjectNamespace<SubscriptionDO>;
  METRICS?: AnalyticsEngineDataset;
  SESSION_TTL_SECONDS?: string;
  ANALYTICS_DATASET?: string;
  CORS_ORIGINS?: string;
}
