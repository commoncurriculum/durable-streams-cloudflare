import type { SubscriptionDO } from "./subscriptions/do";
import type { CoreService } from "./client";
import type { AnalyticsQueryEnv } from "./analytics";
import type { FanoutQueueMessage } from "./subscriptions/types";

export interface AppEnv extends Partial<AnalyticsQueryEnv> {
  CORE: CoreService;
  SUBSCRIPTION_DO: DurableObjectNamespace<SubscriptionDO>;
  METRICS?: AnalyticsEngineDataset;
  AUTH_TOKEN?: string;
  SESSION_TTL_SECONDS?: string;
  ANALYTICS_DATASET?: string;
  CORS_ORIGINS?: string;
  FANOUT_QUEUE?: Queue<FanoutQueueMessage>;
  FANOUT_QUEUE_THRESHOLD?: string;
  PROJECT_KEYS?: KVNamespace;
}
