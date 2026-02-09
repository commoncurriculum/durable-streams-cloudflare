import type { SubscriptionDO } from "./subscriptions/do";
import type { SessionDO } from "./session/do";
import type { CoreService } from "./client";
import type { AnalyticsQueryEnv } from "./analytics";
import type { FanoutQueueMessage } from "./subscriptions/types";

export interface AppEnv extends Partial<AnalyticsQueryEnv> {
  CORE: CoreService;
  SUBSCRIPTION_DO: DurableObjectNamespace<SubscriptionDO>;
  SESSION_DO: DurableObjectNamespace<SessionDO>;
  METRICS?: AnalyticsEngineDataset;
  SESSION_TTL_SECONDS?: string;
  ANALYTICS_DATASET?: string;
  CORS_ORIGINS?: string;
  FANOUT_QUEUE?: Queue<FanoutQueueMessage>;
  FANOUT_QUEUE_THRESHOLD?: string;
  MAX_INLINE_FANOUT?: string;
  /**
   * KV namespace storing per-project signing secrets and stream metadata.
   * SECURITY: Must use private ACL — contains JWT signing secrets.
   */
  REGISTRY: KVNamespace;
}
