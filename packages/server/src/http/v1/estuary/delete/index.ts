import type { BaseEnv } from "../../../router";
import type { StreamDO } from "../../streams";
import type { DeleteEstuaryResult } from "../types";
import { isValidEstuaryId } from "../../../../constants";
import { createMetrics } from "../../../../metrics";

export interface DeleteEstuaryOptions {
  projectId: string;
  estuaryId: string;
}

/**
 * THE ONE deleteEstuary function that does everything.
 *
 * Deletes an estuary:
 * - Deletes the estuary stream via StreamDO
 * - Records metrics
 *
 * Note: EstuaryDO cleanup happens via its alarm mechanism when the stream is deleted.
 * The alarm will handle unsubscribing from all source streams.
 *
 * Called by HTTP and potentially RPC.
 */
export async function deleteEstuary(
  env: BaseEnv,
  opts: DeleteEstuaryOptions
): Promise<DeleteEstuaryResult> {
  const { projectId, estuaryId } = opts;
  const start = Date.now();

  // 1. Validate estuaryId format
  if (!isValidEstuaryId(estuaryId)) {
    throw new Error("Invalid estuaryId format");
  }

  // 2. Delete the estuary stream via StreamDO
  const doKey = `${projectId}/${estuaryId}`;
  const streamStub = env.STREAMS.get(
    env.STREAMS.idFromName(doKey)
  ) as DurableObjectStub<StreamDO>;

  const deleteRequest = new Request(`https://do/v1/stream/${doKey}`, {
    method: "DELETE",
  });
  await streamStub.routeStreamRequest(doKey, deleteRequest);

  // 3. Metrics
  const metrics = createMetrics(env.METRICS);
  metrics.estuaryDelete?.(estuaryId, Date.now() - start);

  return {
    estuaryId,
    deleted: true,
  };
}
