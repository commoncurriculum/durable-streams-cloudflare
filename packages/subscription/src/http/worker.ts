import { WorkerEntrypoint } from "cloudflare:workers";
import { createSubscriptionWorker } from "./create_worker";
import { projectJwtAuth } from "./auth";
import { SubscriptionDO } from "../subscriptions/do";
import { EstuaryDO } from "../estuary/do";
import { getEstuary, touchEstuary, deleteEstuary } from "../estuary";
import { subscribe } from "../subscriptions/subscribe";
import { unsubscribe } from "../subscriptions/unsubscribe";
import { publish } from "../subscriptions/publish";
import type { AppEnv } from "../env";
import type { FanoutQueueMessage } from "../subscriptions/types";
import type {
  EstuaryInfo,
  TouchEstuaryResult,
  DeleteEstuaryResult,
  SubscribeResult,
  UnsubscribeResult,
  PublishResult,
} from "../subscriptions/types";

export default class SubscriptionWorker extends WorkerEntrypoint<AppEnv> {
  #worker = createSubscriptionWorker({ authorize: projectJwtAuth() });

  async fetch(request: Request): Promise<Response> {
    return this.#worker.fetch(request, this.env, this.ctx);
  }

  async queue(batch: MessageBatch<FanoutQueueMessage>): Promise<void> {
    return this.#worker.queue!(batch, this.env, this.ctx);
  }

  // RPC methods for admin dashboard (names unchanged for now)
  async adminGetSession(projectId: string, estuaryId: string): Promise<EstuaryInfo | null> {
    return getEstuary(this.env, projectId, estuaryId);
  }

  async adminSubscribe(
    projectId: string,
    streamId: string,
    estuaryId: string,
    _contentType?: string,
  ): Promise<SubscribeResult> {
    return subscribe(this.env, projectId, streamId, estuaryId);
  }

  async adminUnsubscribe(
    projectId: string,
    streamId: string,
    estuaryId: string,
  ): Promise<UnsubscribeResult> {
    return unsubscribe(this.env, projectId, streamId, estuaryId);
  }

  async adminPublish(
    projectId: string,
    streamId: string,
    payload: ArrayBuffer,
    contentType: string,
  ): Promise<PublishResult> {
    return publish(this.env, projectId, streamId, { payload, contentType });
  }

  async adminTouchSession(projectId: string, estuaryId: string, contentType = "application/json"): Promise<TouchEstuaryResult> {
    return touchEstuary(this.env, projectId, estuaryId, contentType);
  }

  async adminDeleteSession(projectId: string, estuaryId: string): Promise<DeleteEstuaryResult> {
    return deleteEstuary(this.env, projectId, estuaryId);
  }
}

export { SubscriptionWorker, SubscriptionDO, EstuaryDO, createSubscriptionWorker };
export { projectJwtAuth } from "./auth";
export type { SubscriptionAuthResult, SubscriptionRoute, AuthorizeSubscription } from "./auth";
export type { SubscriptionWorkerConfig } from "./create_worker";
