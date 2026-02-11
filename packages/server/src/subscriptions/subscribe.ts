import { createMetrics } from "../metrics";
import { logError } from "../log";
import { DEFAULT_ESTUARY_TTL_SECONDS } from "../constants";
import { putStreamMetadata } from "../storage/registry";
import type { BaseEnv } from "../http";
import type { SubscribeResult } from "./types";

const INTERNAL_BASE_URL = "https://internal/v1/stream";

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
  const sourceHead = await sourceStub.routeStreamRequest(
    sourceDoKey,
    false,
    new Request(INTERNAL_BASE_URL, { method: "HEAD" })
  );
  if (!sourceHead.ok) {
    throw new Error(`Source stream not found: ${sourceDoKey} (status: ${sourceHead.status})`);
  }
  const contentType = sourceHead.headers.get("Content-Type");
  if (!contentType) {
    throw new Error(`Source stream ${sourceDoKey} has no content type`);
  }

  // 1. Create/touch estuary stream in core with the same content type
  const estuaryDoKey = `${projectId}/${estuaryId}`;
  const estuaryStub = env.STREAMS.get(env.STREAMS.idFromName(estuaryDoKey));
  const body = JSON.stringify({ expiresAt });
  const coreResponse = await estuaryStub.routeStreamRequest(
    estuaryDoKey,
    false,
    new Request(INTERNAL_BASE_URL, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body,
    })
  );

  const isNewEstuary = coreResponse.status === 201;
  
  // Write stream metadata to REGISTRY on creation
  if (isNewEstuary && env.REGISTRY) {
    await putStreamMetadata(env.REGISTRY, estuaryDoKey, {
      public: false,
      content_type: contentType,
    });
  }
  // #endregion synced-to-docs:create-estuary-stream

  if (!coreResponse.ok && coreResponse.status !== 409) {
    const errorText = await coreResponse.text();
    throw new Error(`Failed to create estuary stream: ${errorText} (status: ${coreResponse.status})`);
  }

  // If estuary stream already exists, verify content type matches
  if (coreResponse.status === 409) {
    const estuaryHead = await estuaryStub.routeStreamRequest(
      estuaryDoKey,
      false,
      new Request(INTERNAL_BASE_URL, { method: "HEAD" })
    );
    const existingContentType = estuaryHead.headers.get("Content-Type");
    if (estuaryHead.ok && existingContentType && existingContentType !== contentType) {
      throw new Error(
        `Content type mismatch: estuary stream is ${existingContentType} but source stream ${streamId} is ${contentType}. ` +
        `An estuary can only subscribe to streams of the same content type.`,
      );
    }
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
        await estuaryStub.routeStreamRequest(
          estuaryDoKey,
          false,
          new Request(INTERNAL_BASE_URL, { method: "DELETE" })
        );
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
