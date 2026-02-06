import type { PublishParams, PublishResult } from "./types";
import type { AppEnv } from "../env";

export async function publish(
  env: AppEnv,
  projectId: string,
  streamId: string,
  params: PublishParams,
): Promise<PublishResult> {
  const doKey = `${projectId}/${streamId}`;
  const stub = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(doKey));
  return stub.publish(projectId, streamId, params);
}
