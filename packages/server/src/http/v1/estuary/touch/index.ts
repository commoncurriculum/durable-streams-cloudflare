import type { BaseEnv } from "../../../router";
import type { StreamDO } from "../../streams";
import type { EstuaryDO } from "../index";
import type { TouchEstuaryResult } from "../types";
import {
  isValidEstuaryId,
  DEFAULT_ESTUARY_TTL_SECONDS,
} from "../../../../constants";
import { createMetrics } from "../../../../metrics";
import { putStreamMetadata } from "../../../../storage/registry";

export interface TouchEstuaryOptions {
  projectId: string;
  estuaryId: string;
}

/**
 * THE ONE touchEstuary function that does everything.
 *
 * Creates or extends TTL for an estuary:
 * - Creates estuary stream if it doesn't exist
 * - Resets expiry alarm on EstuaryDO
 * - Records metrics
 *
 * Called by HTTP and potentially RPC.
 */
export async function touchEstuary(
  env: BaseEnv,
  opts: TouchEstuaryOptions
): Promise<TouchEstuaryResult> {
  const { projectId, estuaryId } = opts;
  const start = Date.now();

  // 1. Validate estuaryId format
  if (!isValidEstuaryId(estuaryId)) {
    throw new Error("Invalid estuaryId format");
  }

  // 2. Parse TTL from environment
  const parsed = env.ESTUARY_TTL_SECONDS
    ? Number.parseInt(env.ESTUARY_TTL_SECONDS, 10)
    : undefined;
  const ttlSeconds =
    parsed !== undefined && Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_ESTUARY_TTL_SECONDS;
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const contentType = "application/json"; // Default for estuary streams

  // 3. Create/touch estuary stream via StreamDO
  const doKey = `${projectId}/${estuaryId}`;
  const streamStub = env.STREAMS.get(
    env.STREAMS.idFromName(doKey)
  ) as DurableObjectStub<StreamDO>;

  const putRequest = new Request(`https://do/v1/stream/${doKey}`, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: JSON.stringify({ expiresAt }),
  });
  const putResponse = await streamStub.routeStreamRequest(doKey, putRequest);

  // 4. Write stream metadata to REGISTRY on creation
  if (putResponse.status === 201 && env.REGISTRY) {
    await putStreamMetadata(env.REGISTRY, doKey, {
      public: false,
      content_type: contentType,
    });
  }

  // 5. Reset expiry alarm on EstuaryDO
  const estuaryStub = env.ESTUARY_DO.get(
    env.ESTUARY_DO.idFromName(doKey)
  ) as DurableObjectStub<EstuaryDO>;
  await estuaryStub.setExpiry(projectId, estuaryId, ttlSeconds);

  // 6. Metrics
  const metrics = createMetrics(env.METRICS);
  metrics.estuaryTouch?.(estuaryId, Date.now() - start);

  return {
    estuaryId,
    expiresAt,
  };
}
