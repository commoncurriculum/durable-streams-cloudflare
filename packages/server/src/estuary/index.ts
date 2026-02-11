import { createMetrics } from "../metrics";
import { DEFAULT_ESTUARY_TTL_SECONDS } from "../constants";
import { putStreamMetadata } from "../storage/registry";
import type { BaseEnv } from "../http";
import type { EstuaryInfo, TouchEstuaryResult, DeleteEstuaryResult } from "../subscriptions/types";

// #region synced-to-docs:get-estuary
export async function getEstuary(env: BaseEnv, projectId: string, estuaryId: string): Promise<EstuaryInfo | null> {
  const doKey = `${projectId}/${estuaryId}`;
  const stub = env.STREAMS.get(env.STREAMS.idFromName(doKey));
  const meta = await stub.headStream(doKey);
  if (!meta) return null;

  const estuaryStub = env.ESTUARY_DO.get(env.ESTUARY_DO.idFromName(doKey));
  const streamIds = await estuaryStub.getSubscriptions();
  const subscriptions = streamIds.map((streamId) => ({ streamId }));

  return {
    estuaryId,
    estuaryStreamPath: `/v1/stream/${projectId}/${estuaryId}`,
    subscriptions,
    contentType: meta.content_type,
  };
}
// #endregion synced-to-docs:get-estuary

// #region synced-to-docs:touch-estuary
export async function touchEstuary(
  env: BaseEnv, 
  projectId: string, 
  estuaryId: string, 
  contentType = "application/json"
): Promise<TouchEstuaryResult> {
  const start = Date.now();
  const parsed = env.ESTUARY_TTL_SECONDS
    ? Number.parseInt(env.ESTUARY_TTL_SECONDS, 10)
    : undefined;
  const ttlSeconds = parsed !== undefined && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_ESTUARY_TTL_SECONDS;
  const expiresAt = Date.now() + ttlSeconds * 1000;

  const doKey = `${projectId}/${estuaryId}`;
  const stub = env.STREAMS.get(env.STREAMS.idFromName(doKey));
  
  const body = new TextEncoder().encode(JSON.stringify({ expiresAt }));
  const result = await stub.createOrTouchStream(doKey, contentType, body);

  // Write stream metadata to REGISTRY on creation
  if (result.status === 201 && env.REGISTRY) {
    await putStreamMetadata(env.REGISTRY, doKey, {
      public: false,
      content_type: contentType,
    });
  }

  // Reset the expiry alarm on the EstuaryDO
  const estuaryStub = env.ESTUARY_DO.get(env.ESTUARY_DO.idFromName(doKey));
  await estuaryStub.setExpiry(projectId, estuaryId, ttlSeconds);

  createMetrics(env.METRICS).estuaryTouch(estuaryId, Date.now() - start);
  return { estuaryId, expiresAt };
}
// #endregion synced-to-docs:touch-estuary

export async function deleteEstuary(env: BaseEnv, projectId: string, estuaryId: string): Promise<DeleteEstuaryResult> {
  const start = Date.now();
  const doKey = `${projectId}/${estuaryId}`;
  const stub = env.STREAMS.get(env.STREAMS.idFromName(doKey));
  await stub.deleteStream(doKey);
  createMetrics(env.METRICS).estuaryDelete(estuaryId, Date.now() - start);
  return { estuaryId, deleted: true };
}
