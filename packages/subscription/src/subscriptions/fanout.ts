import type { CoreService, PostStreamResult } from "../client";
import { FANOUT_BATCH_SIZE, FANOUT_RPC_TIMEOUT_MS } from "../constants";
import { logWarn } from "../log";
import type { FanoutResult } from "./types";

/**
 * Wrap a promise with a timeout. Rejects with a TimeoutError if the
 * promise doesn't settle within `ms` milliseconds.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("RPC timeout")), ms);
    }),
  ]);
}

/**
 * Fan out a payload to a list of subscriber session streams.
 *
 * Batches writes in groups of FANOUT_BATCH_SIZE using Promise.allSettled().
 * Each RPC call has a per-call timeout (FANOUT_RPC_TIMEOUT_MS).
 * Returns successes, failures, and stale session IDs (404s) so the caller
 * can decide how to handle cleanup.
 */
export async function fanoutToSubscribers(
  env: { CORE: CoreService },
  projectId: string,
  sessionIds: string[],
  payload: ArrayBuffer,
  contentType: string,
  producerHeaders?: { producerId: string; producerEpoch: string; producerSeq: string },
  rpcTimeoutMs: number = FANOUT_RPC_TIMEOUT_MS,
): Promise<FanoutResult> {
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
        return withTimeout(
          env.CORE.postStream(doKey, payload.slice(0), contentType, producerHeaders),
          rpcTimeoutMs,
        );
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
        logWarn({ sessionId: sessionIds[i], status: result.value.status, component: "fanout" }, "fanout RPC returned error status");
        failures++;
      }
    } else {
      logWarn({ sessionId: sessionIds[i], component: "fanout" }, "fanout RPC rejected", result.reason);
      failures++;
    }
  }

  return { successes, failures, staleSessionIds };
}
