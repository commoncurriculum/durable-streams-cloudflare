import { fanoutToSubscribers } from "../subscriptions/fanout";
import { createMetrics } from "../metrics";
import { logError } from "../log";
import { base64ToBuffer } from "../util/base64";
import type { BaseEnv } from "../http";
import type { FanoutQueueMessage } from "../subscriptions/types";

/**
 * Queue consumer for async fanout.
 *
 * Each message contains a batch of estuary IDs and a base64-encoded payload.
 * Calls the same shared fanoutToSubscribers() used by inline fanout.
 */
export async function handleFanoutQueue(
  batch: MessageBatch<FanoutQueueMessage>,
  env: BaseEnv,
): Promise<void> {
  const metrics = createMetrics(env.METRICS);

  for (const message of batch.messages) {
    const { projectId, streamId, estuaryIds, payload: payloadBase64, contentType, producerHeaders } = message.body;
    const start = Date.now();

    try {
      const payload = base64ToBuffer(payloadBase64);
      const result = await fanoutToSubscribers(env, projectId, estuaryIds, payload, contentType, producerHeaders);

      // Remove stale subscribers via DO RPC (project-scoped key)
      if (result.staleEstuaryIds.length > 0) {
        const doKey = `${projectId}/${streamId}`;
        const stub = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(doKey));
        await stub.removeSubscribers(result.staleEstuaryIds);
      }

      // Record metrics
      metrics.fanout({
        streamId,
        subscribers: estuaryIds.length,
        success: result.successes,
        failures: result.failures,
        latencyMs: Date.now() - start,
      });

      // If all writes succeeded or returned 404 (stale), ack
      // Only retry on actual server errors (5xx / network failures)
      const serverErrors = result.failures - result.staleEstuaryIds.length;
      if (serverErrors > 0) {
        message.retry();
      } else {
        message.ack();
      }
    } catch (err) {
      logError({ projectId, streamId, estuaryCount: estuaryIds.length, component: "fanout-queue" }, "fanout queue message failed", err);
      message.retry();
    }
  }
}
