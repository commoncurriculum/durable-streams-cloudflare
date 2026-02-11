import { createMetrics } from "../metrics";
import { logError } from "../log";
import { DEFAULT_ESTUARY_TTL_SECONDS } from "../constants";
import { headStream, putStream, deleteStream as deleteStreamInternal } from "../storage/streams";
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
  const sourceHead = await headStream(env, sourceDoKey);
  if (!sourceHead.ok) {
    throw new Error(`Source stream not found: ${sourceDoKey} (status: ${sourceHead.status})`);
  }
  if (!sourceHead.contentType) {
    throw new Error(`Source stream ${sourceDoKey} has no content type`);
  }
  const contentType = sourceHead.contentType;

  // 1. Create/touch estuary stream in core with the same content type
  const estuaryDoKey = `${projectId}/${estuaryId}`;
  const coreResponse = await putStream(env, estuaryDoKey, { expiresAt, contentType });

  const isNewEstuary = coreResponse.status === 201;
  // #endregion synced-to-docs:create-estuary-stream

  if (!coreResponse.ok && coreResponse.status !== 409) {
    throw new Error(`Failed to create estuary stream: ${coreResponse.body} (status: ${coreResponse.status})`);
  }

  // If estuary stream already exists, verify content type matches
  if (coreResponse.status === 409) {
    const estuaryHead = await headStream(env, estuaryDoKey);
    if (estuaryHead.ok && estuaryHead.contentType && estuaryHead.contentType !== contentType) {
      throw new Error(
        `Content type mismatch: estuary stream is ${estuaryHead.contentType} but source stream ${streamId} is ${contentType}. ` +
        `An estuary can only subscribe to streams of the same content type.`,
      );
    }
  }

  // #region synced-to-docs:add-subscription-to-do
  // 2. Add subscription to DO (project-scoped key)
  const streamDoKey = `${projectId}/${streamId}`;
  const stub = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(streamDoKey));
  try {
    await stub.addSubscriber(estuaryId);
  } catch (err) {
    // Rollback estuary if we just created it
    if (isNewEstuary) {
      try {
        await deleteStreamInternal(env, estuaryDoKey);
      } catch (rollbackErr) {
        logError({ projectId, streamId, estuaryId, component: "subscribe-rollback" }, "failed to rollback estuary stream", rollbackErr);
      }
    }
    throw err;
  }
  // #endregion synced-to-docs:add-subscription-to-do

  // 3. Track subscription on the estuary DO and set/reset expiry alarm
  const estuaryDoStubKey = `${projectId}/${estuaryId}`;
  const estuaryStub = env.ESTUARY_DO.get(env.ESTUARY_DO.idFromName(estuaryDoStubKey));
  await estuaryStub.addSubscription(streamId);
  await estuaryStub.setExpiry(projectId, estuaryId, ttlSeconds);

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
