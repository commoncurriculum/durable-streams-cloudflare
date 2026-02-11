import type { PublishParams, PublishResult } from "./types";
import type { BaseEnv } from "../http";

export async function publish(
  env: BaseEnv,
  projectId: string,
  streamId: string,
  params: PublishParams,
): Promise<PublishResult> {
  const doKey = `${projectId}/${streamId}`;
  const stub = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(doKey));
  return stub.publish(projectId, streamId, params);
}
