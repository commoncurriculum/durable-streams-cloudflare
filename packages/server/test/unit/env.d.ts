/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { StreamDO } from "../../src/http/v1/streams";
import type { StreamSubscribersDO, EstuaryDO, FanoutQueueMessage } from "../../src/http/v1/estuary";

declare global {
  namespace Cloudflare {
    interface Env {
      STREAMS: DurableObjectNamespace<StreamDO>;
      SUBSCRIPTION_DO: DurableObjectNamespace<StreamSubscribersDO>;
      ESTUARY_DO: DurableObjectNamespace<EstuaryDO>;
      R2: R2Bucket;
      METRICS: AnalyticsEngineDataset;
      REGISTRY: KVNamespace;
      CORS_ORIGINS?: string;
      ESTUARY_TTL_SECONDS?: string;
      FANOUT_QUEUE?: Queue<FanoutQueueMessage>;
      FANOUT_QUEUE_THRESHOLD?: string;
      MAX_INLINE_FANOUT?: string;
    }
  }
}
