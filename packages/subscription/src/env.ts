import type { SubscriptionDO } from "./subscriptions/do";
import type { CoreClientEnv } from "./client";
import type { AnalyticsQueryEnv } from "./analytics";
import type { FanoutQueueMessage } from "./subscriptions/types";

export interface AppEnv extends CoreClientEnv, Partial<AnalyticsQueryEnv> {
  SUBSCRIPTION_DO: DurableObjectNamespace<SubscriptionDO>;
  METRICS?: AnalyticsEngineDataset;
  SESSION_TTL_SECONDS?: string;
  ANALYTICS_DATASET?: string;
  CORS_ORIGINS?: string;
  FANOUT_QUEUE?: Queue<FanoutQueueMessage>;
  FANOUT_QUEUE_THRESHOLD?: string;
}
