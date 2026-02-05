import type { SubscriptionDO } from "./do";
import type { PublishParams, PublishResult } from "./types";

interface Env {
  SUBSCRIPTION_DO: DurableObjectNamespace<SubscriptionDO>;
  CORE?: Fetcher;
  CORE_URL: string;
  AUTH_TOKEN?: string;
}

export async function publish(
  env: Env,
  streamId: string,
  params: PublishParams,
): Promise<PublishResult> {
  const stub = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(streamId));
  return stub.publish(streamId, params);
}
