import { WorkerEntrypoint } from "cloudflare:workers";
import { createSubscriptionWorker } from "./create_worker";
import { projectJwtAuth } from "./auth";
import { SubscriptionDO } from "../subscriptions/do";
import { SessionDO } from "../session/do";
import { getSession, touchSession, deleteSession } from "../session";
import { subscribe } from "../subscriptions/subscribe";
import { unsubscribe } from "../subscriptions/unsubscribe";
import { publish } from "../subscriptions/publish";
import type { AppEnv } from "../env";
import type { FanoutQueueMessage } from "../subscriptions/types";
import type {
  SessionInfo,
  TouchSessionResult,
  DeleteSessionResult,
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

  // RPC methods for admin dashboard
  async adminGetSession(projectId: string, sessionId: string): Promise<SessionInfo | null> {
    return getSession(this.env, projectId, sessionId);
  }

  async adminSubscribe(
    projectId: string,
    streamId: string,
    sessionId: string,
    _contentType?: string,
  ): Promise<SubscribeResult> {
    return subscribe(this.env, projectId, streamId, sessionId);
  }

  async adminUnsubscribe(
    projectId: string,
    streamId: string,
    sessionId: string,
  ): Promise<UnsubscribeResult> {
    return unsubscribe(this.env, projectId, streamId, sessionId);
  }

  async adminPublish(
    projectId: string,
    streamId: string,
    payload: ArrayBuffer,
    contentType: string,
  ): Promise<PublishResult> {
    return publish(this.env, projectId, streamId, { payload, contentType });
  }

  async adminTouchSession(projectId: string, sessionId: string, contentType = "application/json"): Promise<TouchSessionResult> {
    return touchSession(this.env, projectId, sessionId, contentType);
  }

  async adminDeleteSession(projectId: string, sessionId: string): Promise<DeleteSessionResult> {
    return deleteSession(this.env, projectId, sessionId);
  }
}

export { SubscriptionWorker, SubscriptionDO, SessionDO, createSubscriptionWorker };
export { projectJwtAuth } from "./auth";
export type { SubscriptionAuthResult, SubscriptionRoute, AuthorizeSubscription } from "./auth";
export type { SubscriptionWorkerConfig } from "./create_worker";
