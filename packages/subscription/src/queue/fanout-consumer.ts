import { fanoutToSubscribers } from "../subscriptions/fanout";
import { createMetrics } from "../metrics";
import { base64ToBuffer } from "../util/base64";
import type { AppEnv } from "../env";
import type { FanoutQueueMessage } from "../subscriptions/types";

/**
 * Queue consumer for async fanout.
 *
 * Each message contains a batch of session IDs and a base64-encoded payload.
 * Calls the same shared fanoutToSubscribers() used by inline fanout.
 */
export async function handleFanoutQueue(
  batch: MessageBatch<FanoutQueueMessage>,
  env: AppEnv,
): Promise<void> {
  const metrics = createMetrics(env.METRICS);

  for (const message of batch.messages) {
    const { streamId, sessionIds, payload: payloadBase64, contentType, producerHeaders } = message.body;
    const start = Date.now();

    try {
      const payload = base64ToBuffer(payloadBase64);
      const result = await fanoutToSubscribers(env, sessionIds, payload, contentType, producerHeaders);

      // Remove stale subscribers via DO RPC
      if (result.staleSessionIds.length > 0) {
        const stub = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(streamId));
        await stub.removeSubscribers(result.staleSessionIds);
      }

      // Record metrics
      metrics.fanout({
        streamId,
        subscribers: sessionIds.length,
        success: result.successes,
        failures: result.failures,
        latencyMs: Date.now() - start,
      });

      // If all writes succeeded or returned 404 (stale), ack
      // Only retry on actual server errors (5xx / network failures)
      const serverErrors = result.failures - result.staleSessionIds.length;
      if (serverErrors > 0) {
        message.retry();
      } else {
        message.ack();
      }
    } catch (err) {
      console.error(`Fanout queue message failed for stream ${streamId}:`, err);
      message.retry();
    }
  }
}
