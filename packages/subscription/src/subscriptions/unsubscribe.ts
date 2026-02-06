import { createMetrics } from "../metrics";
import type { SubscriptionDO } from "./do";
import type { UnsubscribeResult } from "./types";

interface Env {
  SUBSCRIPTION_DO: DurableObjectNamespace<SubscriptionDO>;
  METRICS?: AnalyticsEngineDataset;
}

export async function unsubscribe(
  env: Env,
  streamId: string,
  sessionId: string,
): Promise<UnsubscribeResult> {
  const start = Date.now();
  const stub = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(streamId));
  await stub.removeSubscriber(sessionId);
  createMetrics(env.METRICS).unsubscribe(streamId, sessionId, Date.now() - start);
  return { sessionId, streamId, unsubscribed: true };
}
