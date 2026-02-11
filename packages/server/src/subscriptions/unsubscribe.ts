import { createMetrics } from "../metrics";
import type { BaseEnv } from "../http";
import type { UnsubscribeResult } from "./types";

// #region synced-to-docs:unsubscribe
export async function unsubscribe(
  env: BaseEnv,
  projectId: string,
  streamId: string,
  estuaryId: string,
): Promise<UnsubscribeResult> {
  const start = Date.now();
  const doKey = `${projectId}/${streamId}`;
  const stub = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(doKey));
  await stub.removeSubscriber(estuaryId);

  // Remove subscription from the estuary DO
  const estuaryDoKey = `${projectId}/${estuaryId}`;
  const estuaryStub = env.ESTUARY_DO.get(env.ESTUARY_DO.idFromName(estuaryDoKey));
  await estuaryStub.removeSubscription(streamId);

  createMetrics(env.METRICS).unsubscribe(streamId, estuaryId, Date.now() - start);
  return { estuaryId, streamId, unsubscribed: true };
}
// #endregion synced-to-docs:unsubscribe
