import { createMetrics } from "../metrics";
import { logError } from "../log";
import { DEFAULT_ESTUARY_TTL_SECONDS } from "../constants";
import { putStreamMetadata } from "../storage/registry";
import type { BaseEnv } from "../http";
import type { SubscribeResult } from "./types";

// #region synced-to-docs:create-estuary-stream
export async function subscribe(
  env: BaseEnv,
  projectId: string,
  streamId: string,
  estuaryId: string,
): Promise<SubscribeResult> {
  const start = Date.now();
  const metrics = createMetrics(env.METRICS);
  const parsed = env.ESTUARY_TTL_SECONDS
    ? Number.parseInt(env.ESTUARY_TTL_SECONDS, 10)
    : undefined;
  const ttlSeconds = parsed !== undefined && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_ESTUARY_TTL_SECONDS;
  const expiresAt = Date.now() + ttlSeconds * 1000;

  // 0. Look up the source stream's content type so the estuary stream matches
  const sourceDoKey = `${projectId}/${streamId}`;
  const sourceStub = env.STREAMS.get(env.STREAMS.idFromName(sourceDoKey));
  const sourceMeta = await sourceStub.headStream(sourceDoKey);
  if (!sourceMeta) {
    throw new Error(`Source stream not found: ${sourceDoKey}`);
  }
  const contentType = sourceMeta.content_type;

  // 1. Create/touch estuary stream in core with the same content type
  const estuaryDoKey = `${projectId}/${estuaryId}`;
  const estuaryStub = env.STREAMS.get(env.STREAMS.idFromName(estuaryDoKey));
  const body = new TextEncoder().encode(JSON.stringify({ expiresAt }));
  const result = await estuaryStub.createOrTouchStream(estuaryDoKey, contentType, body);

  const isNewEstuary = result.status === 201;
  
  // Write stream metadata to REGISTRY on creation
  if (isNewEstuary && env.REGISTRY) {
    await putStreamMetadata(env.REGISTRY, estuaryDoKey, {
      public: false,
      content_type: contentType,
    });
  }
  // #endregion synced-to-docs:create-estuary-stream

  // If estuary stream already exists, verify content type matches
  if (!isNewEstuary && result.meta.content_type !== contentType) {
    throw new Error(
      `Content type mismatch: estuary stream is ${result.meta.content_type} but source stream ${streamId} is ${contentType}. ` +
      `An estuary can only subscribe to streams of the same content type.`,
    );
  }

  // #region synced-to-docs:add-subscription-to-do
  // 2. Add subscription to DO (project-scoped key)
  const streamDoKey = `${projectId}/${streamId}`;
  const subStub = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(streamDoKey));
  try {
    await subStub.addSubscriber(estuaryId);
  } catch (err) {
    // Rollback estuary if we just created it
    if (isNewEstuary) {
      try {
        await estuaryStub.deleteStream(estuaryDoKey);
      } catch (rollbackErr) {
        logError({ projectId, streamId, estuaryId, component: "subscribe-rollback" }, "failed to rollback estuary stream", rollbackErr);
      }
    }
    throw err;
  }
  // #endregion synced-to-docs:add-subscription-to-do

  // 3. Track subscription on the estuary DO and set/reset expiry alarm
  const estuaryDoStubKey = `${projectId}/${estuaryId}`;
  const estuaryDOStub = env.ESTUARY_DO.get(env.ESTUARY_DO.idFromName(estuaryDoStubKey));
  await estuaryDOStub.addSubscription(streamId);
  await estuaryDOStub.setExpiry(projectId, estuaryId, ttlSeconds);

  // 4. Metrics
  const latencyMs = Date.now() - start;
  metrics.subscribe(streamId, estuaryId, isNewEstuary, latencyMs);
  if (isNewEstuary) {
    metrics.estuaryCreate(estuaryId, projectId, ttlSeconds, latencyMs);
  }

  // #region synced-to-docs:subscribe-response
  return {
    estuaryId,
    streamId,
    estuaryStreamPath: `/v1/stream/${projectId}/${estuaryId}`,
    expiresAt,
    isNewEstuary,
  };
  // #endregion synced-to-docs:subscribe-response
}
