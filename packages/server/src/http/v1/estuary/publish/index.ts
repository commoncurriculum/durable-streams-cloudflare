import { fanoutToSubscribers } from "./fanout";
import { createMetrics } from "../../../../metrics";
import { logError, logWarn } from "../../../../log";
import { bufferToBase64 } from "../../../../util/base64";
import { FANOUT_QUEUE_THRESHOLD, FANOUT_QUEUE_BATCH_SIZE } from "../../../../constants";
import type { BaseEnv } from "../../../router";
import type { PublishParams, PublishResult, FanoutQueueMessage } from "../types";
import type { StreamSubscribersStorage } from "../../../../storage/stream-subscribers-do";
import type { StreamDO } from "../../streams";

export interface PublishContext {
  env: BaseEnv & {
    FANOUT_QUEUE?: Queue<FanoutQueueMessage>;
    FANOUT_QUEUE_THRESHOLD?: string;
    MAX_INLINE_FANOUT?: string;
  };
  storage: StreamSubscribersStorage;
  nextFanoutSeq: number;
  shouldAttemptInlineFanout: () => boolean;
  updateCircuitBreaker: (successes: number, failures: number) => void;
  removeStaleSubscribers: (estuaryIds: string[]) => Promise<void>;
}

export interface PublishOptions {
  projectId: string;
  streamId: string;
  params: PublishParams;
}

/**
 * THE ONE publish function that does everything.
 *
 * Called by SubscriptionDO.publish() RPC method.
 * Handles:
 * - Writing to source stream
 * - Fanout to all subscribers (inline or queued)
 * - Circuit breaker logic
 * - Metrics recording
 * - Stale subscriber cleanup
 */
export async function publishToStream(
  ctx: PublishContext,
  opts: PublishOptions,
): Promise<{ result: PublishResult; newFanoutSeq: number }> {
  const { projectId, streamId, params } = opts;
  const start = Date.now();
  const metrics = createMetrics(ctx.env.METRICS);

  // 1. Write to source stream in core (project-scoped)
  const sourceDoKey = `${projectId}/${streamId}`;
  // Clone payload — ArrayBuffers are transferred across RPC boundaries,
  // so the source write would detach the buffer before fanout can use it.
  const fanoutPayload = params.payload.slice(0);

  const stub = ctx.env.STREAMS.get(
    ctx.env.STREAMS.idFromName(sourceDoKey),
  ) as DurableObjectStub<StreamDO>;
  const appendResult = await stub.appendStreamRpc(sourceDoKey, new Uint8Array(params.payload));

  // Track fanout sequence for producer-based deduplication.
  // Each subscriber estuary stream gets writes from producer "fanout:<streamId>".
  // The sequence number must be a monotonically increasing integer (0, 1, 2, ...),
  // NOT the hex-encoded source offset.
  const fanoutSeq = ctx.nextFanoutSeq;
  const newFanoutSeq = ctx.nextFanoutSeq + 1;
  await ctx.storage.persistFanoutSeq(newFanoutSeq);

  const fanoutProducerHeaders = {
    producerId: `fanout:${streamId}`,
    producerEpoch: "1",
    producerSeq: fanoutSeq.toString(),
  };

  // 2. Get subscribers (local DO SQLite query)
  const subscriberIds = await ctx.storage.getSubscriberIds();

  // 3. Fan out to all subscriber estuary streams
  let successCount = 0;
  let failureCount = 0;
  let fanoutMode: "inline" | "queued" | "circuit-open" | "skipped" = "inline";

  if (subscriberIds.length > 0) {
    const thresholdParsed = ctx.env.FANOUT_QUEUE_THRESHOLD
      ? parseInt(ctx.env.FANOUT_QUEUE_THRESHOLD, 10)
      : undefined;
    const threshold =
      thresholdParsed !== undefined && Number.isFinite(thresholdParsed) && thresholdParsed > 0
        ? thresholdParsed
        : FANOUT_QUEUE_THRESHOLD;

    if (ctx.env.FANOUT_QUEUE && subscriberIds.length > threshold) {
      // Queued fanout — enqueue and return immediately
      try {
        await enqueueFanout(
          ctx.env.FANOUT_QUEUE,
          projectId,
          streamId,
          subscriberIds,
          fanoutPayload,
          params.contentType,
          fanoutProducerHeaders,
        );
        fanoutMode = "queued";
        metrics.fanoutQueued(streamId, subscriberIds.length, Date.now() - start);
      } catch (err) {
        logError(
          {
            projectId,
            streamId,
            subscribers: subscriberIds.length,
            component: "fanout-queue",
          },
          "queue enqueue failed, falling back to inline fanout",
          err,
        );
        if (!ctx.shouldAttemptInlineFanout()) {
          fanoutMode = "circuit-open";
        } else {
          const fanoutResult = await fanoutToSubscribers(
            ctx.env,
            projectId,
            subscriberIds,
            fanoutPayload,
            params.contentType,
            fanoutProducerHeaders,
          );
          successCount = fanoutResult.successes;
          failureCount = fanoutResult.failures;
          ctx.updateCircuitBreaker(fanoutResult.successes, fanoutResult.failures);
          ctx.removeStaleSubscribers(fanoutResult.staleEstuaryIds);
        }
      }
    } else if (!ctx.shouldAttemptInlineFanout()) {
      // Circuit breaker is open — skip inline fanout entirely.
      // Source write already committed; never return an error here.
      fanoutMode = "circuit-open";
    } else {
      // Inline fanout
      const fanoutResult = await fanoutToSubscribers(
        ctx.env,
        projectId,
        subscriberIds,
        fanoutPayload,
        params.contentType,
        fanoutProducerHeaders,
      );
      successCount = fanoutResult.successes;
      failureCount = fanoutResult.failures;
      ctx.updateCircuitBreaker(fanoutResult.successes, fanoutResult.failures);
      await ctx.removeStaleSubscribers(fanoutResult.staleEstuaryIds);
    }

    // Record fanout metrics (only for inline — queued records its own)
    if (fanoutMode === "inline") {
      const latencyMs = Date.now() - start;
      metrics.fanout({
        streamId,
        subscribers: subscriberIds.length,
        success: successCount,
        failures: failureCount,
        latencyMs,
      });
      if (failureCount > 0) {
        logWarn(
          {
            streamId,
            subscribers: subscriberIds.length,
            successes: successCount,
            failures: failureCount,
            latencyMs,
            component: "fanout",
          },
          "inline fanout completed with failures",
        );
      }
    } else if (fanoutMode === "circuit-open") {
      logWarn(
        { streamId, subscribers: subscriberIds.length, component: "fanout" },
        "fanout skipped: circuit breaker open",
      );
    }
  }

  // Record publish metric
  metrics.publish(streamId, subscriberIds.length, Date.now() - start);

  return {
    result: {
      status: 204,
      nextOffset: appendResult.tailOffset.toString(),
      upToDate: null,
      streamClosed: null,
      body: "",
      fanoutCount: subscriberIds.length,
      fanoutSuccesses: successCount,
      fanoutFailures: failureCount,
      fanoutMode,
    },
    newFanoutSeq,
  };
}

/**
 * Helper function to enqueue fanout messages to the queue.
 */
async function enqueueFanout(
  queue: Queue<FanoutQueueMessage>,
  projectId: string,
  streamId: string,
  estuaryIds: string[],
  payload: ArrayBuffer,
  contentType: string,
  producerHeaders?: {
    producerId: string;
    producerEpoch: string;
    producerSeq: string;
  },
): Promise<void> {
  const payloadBase64 = bufferToBase64(payload);

  const messages: { body: FanoutQueueMessage }[] = [];
  for (let i = 0; i < estuaryIds.length; i += FANOUT_QUEUE_BATCH_SIZE) {
    const batch = estuaryIds.slice(i, i + FANOUT_QUEUE_BATCH_SIZE);
    messages.push({
      body: {
        projectId,
        streamId,
        estuaryIds: batch,
        payload: payloadBase64,
        contentType,
        producerHeaders,
      },
    });
  }

  // sendBatch has a 100-message limit — chunk if needed
  const SEND_BATCH_LIMIT = 100;
  for (let i = 0; i < messages.length; i += SEND_BATCH_LIMIT) {
    await queue.sendBatch(messages.slice(i, i + SEND_BATCH_LIMIT));
  }
}
