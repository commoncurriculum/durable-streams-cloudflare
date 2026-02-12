import type { BaseEnv } from "../../../router";
import type { StreamDO } from "../../streams";
import type { EstuaryDO } from "../index";
import type { GetEstuaryResult } from "../types";
import { isValidEstuaryId } from "../../../../constants";
import { createMetrics } from "../../../../metrics";

export interface GetEstuaryOptions {
  projectId: string;
  estuaryId: string;
}

/**
 * THE ONE getEstuary function that does everything.
 *
 * Gets information about an estuary including:
 * - Which source streams it subscribes to
 * - The estuary stream metadata (content type)
 *
 * Called by HTTP and potentially RPC.
 */
export async function getEstuary(
  env: BaseEnv,
  opts: GetEstuaryOptions
): Promise<GetEstuaryResult> {
  const { projectId, estuaryId } = opts;
  const start = Date.now();

  // 1. Validate estuaryId format
  if (!isValidEstuaryId(estuaryId)) {
    throw new Error("Invalid estuaryId format");
  }

  // 2. Get stream metadata from StreamDO
  const doKey = `${projectId}/${estuaryId}`;
  const streamStub = env.STREAMS.get(
    env.STREAMS.idFromName(doKey)
  ) as DurableObjectStub<StreamDO>;
  const meta = await streamStub.getStreamMeta(estuaryId);

  if (!meta) {
    throw new Error("Estuary not found");
  }

  // 3. Get subscriptions from EstuaryDO
  const estuaryStub = env.ESTUARY_DO.get(
    env.ESTUARY_DO.idFromName(doKey)
  ) as DurableObjectStub<EstuaryDO>;
  const streamIds = await estuaryStub.getSubscriptions();
  const subscriptions = streamIds.map((streamId: string) => ({ streamId }));

  // 4. Metrics
  const metrics = createMetrics(env.METRICS);
  metrics.estuaryGet?.(estuaryId, Date.now() - start);

  return {
    estuaryId,
    estuaryStreamPath: `/v1/stream/${projectId}/${estuaryId}`,
    subscriptions,
    contentType: meta.content_type,
  };
}
