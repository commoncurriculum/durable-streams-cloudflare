import type { BaseEnv } from "../../../router";
import { FANOUT_BATCH_SIZE, FANOUT_RPC_TIMEOUT_MS } from "../../../../constants";
import { logWarn } from "../../../../log";

export interface FanoutResult {
  successes: number;
  failures: number;
  staleEstuaryIds: string[];
}

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
 * Fan out a payload to a list of subscriber estuary streams.
 *
 * Batches writes in groups of FANOUT_BATCH_SIZE using Promise.allSettled().
 * Each RPC call has a per-call timeout (FANOUT_RPC_TIMEOUT_MS).
 * Returns successes, failures, and stale estuary IDs (404s) so the caller
 * can decide how to handle cleanup.
 */
export async function fanoutToSubscribers(
  env: BaseEnv,
  projectId: string,
  estuaryIds: string[],
  payload: ArrayBuffer,
  contentType: string,
  producerHeaders?: {
    producerId: string;
    producerEpoch: string;
    producerSeq: string;
  },
  rpcTimeoutMs: number = FANOUT_RPC_TIMEOUT_MS,
): Promise<FanoutResult> {
  let successes = 0;
  let failures = 0;
  const staleEstuaryIds: string[] = [];

  const results: PromiseSettledResult<Response>[] = [];
  for (let i = 0; i < estuaryIds.length; i += FANOUT_BATCH_SIZE) {
    const batch = estuaryIds.slice(i, i + FANOUT_BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map((estuaryId) => {
        const doKey = `${projectId}/${estuaryId}`;
        const stub = env.STREAMS.get(env.STREAMS.idFromName(doKey));

        // Build POST request to append to stream
        const headers = new Headers({ "Content-Type": contentType });
        if (producerHeaders) {
          headers.set("X-Producer-Id", producerHeaders.producerId);
          headers.set("X-Producer-Epoch", producerHeaders.producerEpoch);
          headers.set("X-Producer-Seq", producerHeaders.producerSeq);
        }

        const request = new Request(`https://do/v1/stream/${doKey}`, {
          method: "POST",
          headers,
          // Clone payload — ArrayBuffers are transferred across RPC boundaries,
          // so each routeStreamRequest call needs its own copy.
          body: payload.slice(0),
        });

        return withTimeout(stub.routeStreamRequest(doKey, request), rpcTimeoutMs);
      }),
    );
    results.push(...batchResults);
  }

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      const response = result.value;
      if (response.ok) {
        successes++;
      } else if (response.status === 404) {
        // Stale subscriber - stream doesn't exist
        staleEstuaryIds.push(estuaryIds[i]);
        failures++;
      } else {
        // Other error
        logWarn(
          {
            estuaryId: estuaryIds[i],
            component: "fanout",
            status: response.status,
          },
          "fanout RPC failed",
        );
        failures++;
      }
    } else {
      const error = result.reason;
      logWarn({ estuaryId: estuaryIds[i], component: "fanout" }, "fanout RPC rejected", error);
      failures++;
    }
  }

  return { successes, failures, staleEstuaryIds };
}
