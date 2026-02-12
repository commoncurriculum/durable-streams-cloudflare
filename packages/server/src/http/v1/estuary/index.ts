import { DurableObject } from "cloudflare:workers";
import { logError, logInfo } from "../../../log";
import type { StreamSubscribersDO } from "./stream-subscribers-do";
import type { StreamDO } from "../streams";
import { EstuaryDoStorage } from "../../../storage";

export interface EstuaryDOEnv {
  STREAMS: DurableObjectNamespace<StreamDO>;
  SUBSCRIPTION_DO: DurableObjectNamespace<StreamSubscribersDO>;
  METRICS?: AnalyticsEngineDataset;
}

/**
 * EstuaryDO - A Durable Object that manages a single estuary.
 *
 * Each estuary gets its own EstuaryDO instance with its own SQLite database.
 * Tracks which source streams this estuary subscribes to (reverse lookup).
 * Handles TTL/expiry - when estuary expires, cleans up subscriptions in all SubscriptionDOs.
 */
export class EstuaryDO extends DurableObject<EstuaryDOEnv> {
  private storage: EstuaryDoStorage;

  constructor(ctx: DurableObjectState, env: EstuaryDOEnv) {
    super(ctx, env);
    this.storage = new EstuaryDoStorage(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      this.storage.initSchema();
    });
  }

  async setExpiry(
    project: string,
    estuaryId: string,
    ttlSeconds: number
  ): Promise<void> {
    await this.storage.setEstuaryInfo(project, estuaryId);
    await this.ctx.storage.setAlarm(Date.now() + ttlSeconds * 1000);
  }

  async alarm(): Promise<void> {
    const info = await this.storage.getEstuaryInfo();
    if (!info) return;

    const { project, estuary_id: estuaryId } = info;
    logInfo(
      { estuaryId, project, component: "estuary-alarm" },
      "estuary expired, cleaning up"
    );

    // Remove this estuary from all SubscriptionDOs
    const streamIds = await this.getSubscriptions();
    const BATCH_SIZE = 20;
    for (let i = 0; i < streamIds.length; i += BATCH_SIZE) {
      const batch = streamIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (streamId) => {
          const doKey = `${project}/${streamId}`;
          const stub = this.env.SUBSCRIPTION_DO.get(
            this.env.SUBSCRIPTION_DO.idFromName(doKey)
          );
          await stub.removeSubscriber(estuaryId);
        })
      );
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === "rejected") {
          logError(
            {
              estuaryId,
              streamId: batch[j],
              project,
              component: "estuary-alarm",
            },
            "failed to remove subscription",
            (results[j] as PromiseRejectedResult).reason
          );
        }
      }
    }

    // Delete the estuary stream via HTTP interface
    try {
      const doKey = `${project}/${estuaryId}`;
      const stub = this.env.STREAMS.get(this.env.STREAMS.idFromName(doKey));
      const deleteRequest = new Request(`https://do/v1/stream/${doKey}`, {
        method: "DELETE",
      });
      await stub.routeStreamRequest(doKey, deleteRequest);
    } catch (err) {
      logError(
        { estuaryId, project, component: "estuary-alarm" },
        "failed to delete estuary stream",
        err
      );
    }

    // Clean up local state
    await this.storage.clearData();
  }

  async addSubscription(streamId: string): Promise<void> {
    await this.storage.addSubscription(streamId, Date.now());
  }

  async removeSubscription(streamId: string): Promise<void> {
    await this.storage.removeSubscription(streamId);
  }

  async getSubscriptions(): Promise<string[]> {
    return await this.storage.getSubscriptions();
  }
}

// Re-export StreamSubscribersDO and types for convenience
export { StreamSubscribersDO } from "./stream-subscribers-do";
export type { StreamSubscribersDOEnv } from "./stream-subscribers-do";

export type {
  SubscribeResult,
  UnsubscribeResult,
  DeleteEstuaryResult,
  GetEstuaryResult,
  TouchEstuaryResult,
  EstuaryInfo,
  PublishParams,
  PublishResult,
  FanoutQueueMessage,
  SubscriberInfo,
  GetSubscribersResult,
} from "./types";
