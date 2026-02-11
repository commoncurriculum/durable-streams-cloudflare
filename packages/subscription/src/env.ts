import type { SubscriptionDO } from "./subscriptions/do";
import type { EstuaryDO } from "./estuary/do";
import type { CoreService } from "./client";
import type { FanoutQueueMessage } from "./subscriptions/types";

export interface AppEnv {
  CORE: CoreService;
  SUBSCRIPTION_DO: DurableObjectNamespace<SubscriptionDO>;
  ESTUARY_DO: DurableObjectNamespace<EstuaryDO>;
  METRICS?: AnalyticsEngineDataset;
  ESTUARY_TTL_SECONDS?: string;
  FANOUT_QUEUE?: Queue<FanoutQueueMessage>;
  FANOUT_QUEUE_THRESHOLD?: string;
  MAX_INLINE_FANOUT?: string;
  /**
   * KV namespace storing per-project signing secrets and stream metadata.
   * SECURITY: Must use private ACL — contains JWT signing secrets.
   */
  REGISTRY: KVNamespace;
}
