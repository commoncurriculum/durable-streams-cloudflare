import type { BaseEnv } from "../../../router";
import type { StreamDO } from "../../streams";
import type { StreamSubscribersDO, EstuaryDO } from "../index";
import type { SubscribeResult } from "../types";
import {
  isValidEstuaryId,
  DEFAULT_ESTUARY_TTL_SECONDS,
} from "../../../../constants";
import { createMetrics } from "../../../../metrics";
import { putStreamMetadata } from "../../../../storage/registry";
import { logError } from "../../../../log";

export interface SubscribeOptions {
  projectId: string;
  streamId: string;
  estuaryId: string;
}

/**
 * THE ONE subscribeToStream function that does everything.
 *
 * Subscribes an estuary to a source stream:
 * - Validates IDs
 * - Checks source stream exists
 * - Creates/touches estuary stream with matching content type
 * - Adds to StreamSubscribersDO (for fanout)
 * - Adds to EstuaryDO (for reverse lookup/cleanup)
 * - Records metrics
 *
 * Called by HTTP and potentially RPC.
 */
export async function subscribeToStream(
  env: BaseEnv,
  opts: SubscribeOptions
): Promise<SubscribeResult> {
  const { projectId, streamId, estuaryId } = opts;
  const start = Date.now();
  const metrics = createMetrics(env.METRICS);

  // 1. Validate estuaryId format
  if (!isValidEstuaryId(estuaryId)) {
    throw new Error("Invalid estuaryId format");
  }

  // 2. Parse TTL
  const parsed = env.ESTUARY_TTL_SECONDS
    ? Number.parseInt(env.ESTUARY_TTL_SECONDS, 10)
    : undefined;
  const ttlSeconds =
    parsed !== undefined && Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_ESTUARY_TTL_SECONDS;
  const expiresAt = Date.now() + ttlSeconds * 1000;

  // 3. Check source stream exists and get content type
  const sourceDoKey = `${projectId}/${streamId}`;
  const sourceStub = env.STREAMS.get(
    env.STREAMS.idFromName(sourceDoKey)
  ) as DurableObjectStub<StreamDO>;
  const sourceMeta = await sourceStub.getStreamMeta(streamId);
  if (!sourceMeta) {
    throw new Error(`Source stream not found: ${sourceDoKey}`);
  }
  const contentType = sourceMeta.content_type;

  // 4. Create/touch estuary stream with same content type
  const estuaryDoKey = `${projectId}/${estuaryId}`;
  const estuaryStreamStub = env.STREAMS.get(
    env.STREAMS.idFromName(estuaryDoKey)
  ) as DurableObjectStub<StreamDO>;

  const putRequest = new Request(`https://do/v1/stream/${estuaryDoKey}`, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: JSON.stringify({ expiresAt }),
  });
  const putResponse = await estuaryStreamStub.routeStreamRequest(
    estuaryDoKey,
    putRequest
  );

  const isNewEstuary = putResponse.status === 201;

  // 5. Write stream metadata to REGISTRY on creation
  if (isNewEstuary && env.REGISTRY) {
    await putStreamMetadata(env.REGISTRY, estuaryDoKey, {
      public: false,
      content_type: contentType,
    });
  }

  // 6. If estuary already exists, verify content type matches
  if (!isNewEstuary) {
    const estuaryMeta = await estuaryStreamStub.getStreamMeta(estuaryId);
    if (estuaryMeta && estuaryMeta.content_type !== contentType) {
      throw new Error(
        `Content type mismatch: estuary stream is ${estuaryMeta.content_type} but source stream ${streamId} is ${contentType}. An estuary can only subscribe to streams of the same content type.`
      );
    }
  }

  // 7. Add subscription to StreamSubscribersDO
  const subStub = env.SUBSCRIPTION_DO.get(
    env.SUBSCRIPTION_DO.idFromName(sourceDoKey)
  ) as DurableObjectStub<StreamSubscribersDO>;
  try {
    await subStub.addSubscriber(estuaryId);
  } catch (err) {
    // Rollback estuary if we just created it
    if (isNewEstuary) {
      try {
        const deleteRequest = new Request(
          `https://do/v1/stream/${estuaryDoKey}`,
          { method: "DELETE" }
        );
        await estuaryStreamStub.routeStreamRequest(estuaryDoKey, deleteRequest);
      } catch (rollbackErr) {
        logError(
          { projectId, streamId, estuaryId, component: "subscribe-rollback" },
          "failed to rollback estuary stream",
          rollbackErr
        );
      }
    }
    throw err;
  }

  // 8. Track subscription on EstuaryDO and set expiry
  const estuaryDOStub = env.ESTUARY_DO.get(
    env.ESTUARY_DO.idFromName(estuaryDoKey)
  ) as DurableObjectStub<EstuaryDO>;
  await estuaryDOStub.addSubscription(streamId);
  await estuaryDOStub.setExpiry(projectId, estuaryId, ttlSeconds);

  // 9. Metrics
  const latencyMs = Date.now() - start;
  metrics.subscribe?.(streamId, estuaryId, isNewEstuary, latencyMs);
  if (isNewEstuary) {
    metrics.estuaryCreate?.(estuaryId, projectId, ttlSeconds, latencyMs);
  }

  return {
    estuaryId,
    streamId,
    estuaryStreamPath: `/v1/stream/${projectId}/${estuaryId}`,
    expiresAt,
    isNewEstuary,
  };
}
