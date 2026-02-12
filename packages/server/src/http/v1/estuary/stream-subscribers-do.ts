/**
 * StreamSubscribersDO - Manages subscribers for a single source stream.
 *
 * Each source stream gets its own StreamSubscribersDO instance.
 * Tracks which estuaries subscribe to this stream.
 * Provides publish() RPC method for fanout to subscribers.
 *
 * This is an INTERNAL DO - only called via RPC, never via HTTP.
 */

import { DurableObject } from "cloudflare:workers";
import { logInfo } from "../../../log";
import { CIRCUIT_BREAKER_FAILURE_THRESHOLD, CIRCUIT_BREAKER_RECOVERY_MS } from "../../../constants";
import type { BaseEnv } from "../../router";
import type {
  PublishParams,
  PublishResult,
  GetSubscribersResult,
  FanoutQueueMessage,
} from "./types";
import { StreamSubscribersDoStorage } from "../../../storage";
import { publishToStream } from "./publish";
import type { PublishContext } from "./publish";

export interface StreamSubscribersDOEnv extends BaseEnv {
  FANOUT_QUEUE?: Queue<FanoutQueueMessage>;
  FANOUT_QUEUE_THRESHOLD?: string;
  MAX_INLINE_FANOUT?: string;
}

type CircuitState = "closed" | "open" | "half-open";

export class StreamSubscribersDO extends DurableObject<StreamSubscribersDOEnv> {
  private storage: StreamSubscribersDoStorage;
  private nextFanoutSeq: number;

  // Circuit breaker for inline fanout protection
  private circuitState: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureTime = 0;

  constructor(ctx: DurableObjectState, env: StreamSubscribersDOEnv) {
    super(ctx, env);
    this.storage = new StreamSubscribersDoStorage(ctx.storage);
    this.nextFanoutSeq = 0;
    ctx.blockConcurrencyWhile(async () => {
      this.storage.initSchema();
      this.nextFanoutSeq = await this.storage.loadFanoutSeq();
    });
  }

  // ============================================================================
  // Subscriber Management (RPC methods)
  // ============================================================================

  async addSubscriber(estuaryId: string): Promise<void> {
    await this.storage.addSubscriber(estuaryId, Date.now());
  }

  async removeSubscriber(estuaryId: string): Promise<void> {
    await this.storage.removeSubscriber(estuaryId);
  }

  async removeSubscribers(estuaryIds: string[]): Promise<void> {
    await this.storage.removeSubscribers(estuaryIds);
  }

  async getSubscribers(streamId: string): Promise<GetSubscribersResult> {
    const subscribers = await this.storage.getSubscribersWithTimestamps();
    return {
      streamId,
      subscribers: subscribers.map((s) => ({
        estuaryId: s.estuary_id,
        subscribedAt: s.subscribed_at,
      })),
      count: subscribers.length,
    };
  }

  // ============================================================================
  // Publish (RPC entrypoint for fanout)
  // ============================================================================

  async publish(
    projectId: string,
    streamId: string,
    params: PublishParams,
  ): Promise<PublishResult> {
    // Build context for THE ONE publish function
    const ctx: PublishContext = {
      env: this.env,
      storage: this.storage,
      nextFanoutSeq: this.nextFanoutSeq,
      shouldAttemptInlineFanout: () => this.shouldAttemptInlineFanout(),
      updateCircuitBreaker: (successes, failures) => this.updateCircuitBreaker(successes, failures),
      removeStaleSubscribers: async (estuaryIds) =>
        await this.storage.removeSubscribers(estuaryIds),
    };

    // Call THE ONE publish function
    const { result, newFanoutSeq } = await publishToStream(ctx, {
      projectId,
      streamId,
      params,
    });

    // Update sequence number
    this.nextFanoutSeq = newFanoutSeq;

    return result;
  }

  // ============================================================================
  // Circuit Breaker (private)
  // ============================================================================

  private shouldAttemptInlineFanout(): boolean {
    if (this.circuitState === "closed") return true;

    if (this.circuitState === "open") {
      if (Date.now() - this.lastFailureTime >= CIRCUIT_BREAKER_RECOVERY_MS) {
        this.circuitState = "half-open";
        return true;
      }
      return false;
    }

    // half-open: allow one attempt
    return true;
  }

  private updateCircuitBreaker(successes: number, failures: number): void {
    if (failures === 0) {
      // All succeeded — close circuit
      this.circuitState = "closed";
      this.consecutiveFailures = 0;
      return;
    }

    if (successes > 0 && this.circuitState === "half-open") {
      // Partial success in half-open — close circuit
      this.circuitState = "closed";
      this.consecutiveFailures = 0;
      return;
    }

    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.consecutiveFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
      this.circuitState = "open";
      logInfo(
        {
          consecutiveFailures: this.consecutiveFailures,
          component: "circuit-breaker",
        },
        "circuit breaker opened",
      );
    }
  }
}
