import type { PublishParams, PublishResult } from "./types";
import type { AppEnv } from "../env";

export async function publish(
  env: AppEnv,
  streamId: string,
  params: PublishParams,
): Promise<PublishResult> {
  const stub = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(streamId));
  return stub.publish(streamId, params);
}
