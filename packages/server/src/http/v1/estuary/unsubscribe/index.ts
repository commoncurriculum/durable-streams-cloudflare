import type { BaseEnv } from "../../../router";
import type { StreamSubscribersDO, EstuaryDO } from "../index";
import type { UnsubscribeResult } from "../types";
import { isValidEstuaryId } from "../../../../constants";
import { createMetrics } from "../../../../metrics";

export interface UnsubscribeOptions {
  projectId: string;
  streamId: string;
  estuaryId: string;
}

/**
 * THE ONE unsubscribeFromStream function that does everything.
 *
 * Removes an estuary's subscription to a source stream:
 * - Validates IDs
 * - Removes from StreamSubscribersDO (stops fanout)
 * - Removes from EstuaryDO (reverse lookup cleanup)
 * - Records metrics
 *
 * Called by HTTP and potentially RPC.
 */
export async function unsubscribeFromStream(
  env: BaseEnv,
  opts: UnsubscribeOptions
): Promise<UnsubscribeResult> {
  const { projectId, streamId, estuaryId } = opts;
  const start = Date.now();
  const metrics = createMetrics(env.METRICS);

  // 1. Validate estuaryId format
  if (!isValidEstuaryId(estuaryId)) {
    throw new Error("Invalid estuaryId format");
  }

  // 2. Remove subscription from StreamSubscribersDO
  const sourceDoKey = `${projectId}/${streamId}`;
  const subStub = env.SUBSCRIPTION_DO.get(
    env.SUBSCRIPTION_DO.idFromName(sourceDoKey)
  ) as DurableObjectStub<StreamSubscribersDO>;
  await subStub.removeSubscriber(estuaryId);

  // 3. Remove subscription tracking from EstuaryDO
  const estuaryDoKey = `${projectId}/${estuaryId}`;
  const estuaryDOStub = env.ESTUARY_DO.get(
    env.ESTUARY_DO.idFromName(estuaryDoKey)
  ) as DurableObjectStub<EstuaryDO>;
  await estuaryDOStub.removeSubscription(streamId);

  // 4. Metrics
  const latencyMs = Date.now() - start;
  metrics.unsubscribe?.(streamId, estuaryId, latencyMs);

  return {
    success: true,
  };
}
