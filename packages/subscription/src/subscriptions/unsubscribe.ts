import { createMetrics } from "../metrics";
import type { AppEnv } from "../env";
import type { UnsubscribeResult } from "./types";

// #region synced-to-docs:unsubscribe
export async function unsubscribe(
  env: AppEnv,
  projectId: string,
  streamId: string,
  sessionId: string,
): Promise<UnsubscribeResult> {
  const start = Date.now();
  const doKey = `${projectId}/${streamId}`;
  const stub = env.SUBSCRIPTION_DO.get(env.SUBSCRIPTION_DO.idFromName(doKey));
  await stub.removeSubscriber(sessionId);

  // Remove subscription from the session DO
  const sessionDoKey = `${projectId}/${sessionId}`;
  const sessionStub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionDoKey));
  await sessionStub.removeSubscription(streamId);

  createMetrics(env.METRICS).unsubscribe(streamId, sessionId, Date.now() - start);
  return { sessionId, streamId, unsubscribed: true };
}
// #endregion synced-to-docs:unsubscribe
