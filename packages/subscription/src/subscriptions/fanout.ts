import type { CoreService, PostStreamResult } from "../client";
import { FANOUT_BATCH_SIZE } from "../constants";
import type { FanoutResult } from "./types";

/**
 * Fan out a payload to a list of subscriber session streams.
 *
 * Batches writes in groups of FANOUT_BATCH_SIZE using Promise.allSettled().
 * Returns successes, failures, and stale session IDs (404s) so the caller
 * can decide how to handle cleanup.
 */
export async function fanoutToSubscribers(
  env: { CORE: CoreService },
  projectId: string,
  sessionIds: string[],
  payload: ArrayBuffer,
  _contentType: string,
  producerHeaders?: { producerId: string; producerEpoch: string; producerSeq: string },
): Promise<FanoutResult> {
  // Session streams are always created as application/octet-stream (see subscribe.ts)
  // so they can accept payloads of any content type without validation.
  // Fan-out must use that same content type regardless of the source stream's
  // content type, otherwise core returns 409 content-type mismatch.
  const sessionContentType = "application/octet-stream";

  let successes = 0;
  let failures = 0;
  const staleSessionIds: string[] = [];

  const results: PromiseSettledResult<PostStreamResult>[] = [];
  for (let i = 0; i < sessionIds.length; i += FANOUT_BATCH_SIZE) {
    const batch = sessionIds.slice(i, i + FANOUT_BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map((sessionId) => {
        const doKey = `${projectId}/${sessionId}`;
        // Clone payload — ArrayBuffers are transferred across RPC boundaries,
        // so each postStream call needs its own copy.
        return env.CORE.postStream(doKey, payload.slice(0), sessionContentType, producerHeaders);
      }),
    );
    results.push(...batchResults);
  }

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      if (result.value.ok) {
        successes++;
      } else if (result.value.status === 404) {
        staleSessionIds.push(sessionIds[i]);
        failures++;
      } else {
        failures++;
      }
    } else {
      failures++;
    }
  }

  return { successes, failures, staleSessionIds };
}
