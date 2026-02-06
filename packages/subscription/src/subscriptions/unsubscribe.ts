import { createMetrics } from "../metrics";
import type { AppEnv } from "../env";
import type { UnsubscribeResult } from "./types";

export async function unsubscribe(
  env: AppEnv,
  streamId: string,
  sessionId: string,
): Promise<UnsubscribeResult> {
  const start = Date.now();
  const stub = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(streamId));
  await stub.removeSubscriber(sessionId);
  createMetrics(env.METRICS).unsubscribe(streamId, sessionId, Date.now() - start);
  return { sessionId, streamId, unsubscribed: true };
}
