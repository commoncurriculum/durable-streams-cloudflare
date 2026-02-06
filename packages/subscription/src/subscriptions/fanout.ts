import { fetchFromCore, type CoreClientEnv } from "../client";
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
  env: CoreClientEnv,
  sessionIds: string[],
  payload: ArrayBuffer,
  contentType: string,
  producerHeaders?: Record<string, string>,
): Promise<FanoutResult> {
  let successes = 0;
  let failures = 0;
  const staleSessionIds: string[] = [];

  const results: PromiseSettledResult<Response>[] = [];
  for (let i = 0; i < sessionIds.length; i += FANOUT_BATCH_SIZE) {
    const batch = sessionIds.slice(i, i + FANOUT_BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map((sessionId) => {
        const path = `/v1/stream/session:${sessionId}`;
        const headers: Record<string, string> = {
          "Content-Type": contentType,
          ...producerHeaders,
        };
        return fetchFromCore(env, path, {
          method: "POST",
          headers,
          body: payload,
        });
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
