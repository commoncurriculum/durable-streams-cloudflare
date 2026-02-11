import type { BaseEnv } from "../http";
import { FANOUT_BATCH_SIZE, FANOUT_RPC_TIMEOUT_MS } from "../constants";
import { logWarn } from "../log";
import type { FanoutResult } from "./types";

const INTERNAL_BASE_URL = "https://internal/v1/stream";

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
  producerHeaders?: { producerId: string; producerEpoch: string; producerSeq: string },
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
        const headers: Record<string, string> = { "Content-Type": contentType };
        if (producerHeaders) {
          headers["X-Producer-Id"] = producerHeaders.producerId;
          headers["X-Producer-Epoch"] = producerHeaders.producerEpoch;
          headers["X-Producer-Seq"] = producerHeaders.producerSeq;
        }
        // Clone payload — ArrayBuffers are transferred across RPC boundaries,
        // so each postStream call needs its own copy.
        return withTimeout(
          stub.routeStreamRequest(
            doKey,
            false,
            new Request(INTERNAL_BASE_URL, {
              method: "POST",
              headers,
              body: payload.slice(0),
            })
          ),
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
        staleEstuaryIds.push(estuaryIds[i]);
        failures++;
      } else {
        logWarn({ estuaryId: estuaryIds[i], status: result.value.status, component: "fanout" }, "fanout RPC returned error status");
        failures++;
      }
    } else {
      logWarn({ estuaryId: estuaryIds[i], component: "fanout" }, "fanout RPC rejected", result.reason);
      failures++;
    }
  }

  return { successes, failures, staleEstuaryIds };
}
