import { createSubscriptionWorker } from "./create_worker";
import { projectKeyAuth } from "./auth";
import { SubscriptionDO } from "../subscriptions/do";

export default createSubscriptionWorker({ authorize: projectKeyAuth() });

export { SubscriptionDO, createSubscriptionWorker };
export { bearerTokenAuth, projectKeyAuth } from "./auth";
export type { SubscriptionAuthResult, SubscriptionRoute, AuthorizeSubscription } from "./auth";
export type { SubscriptionWorkerConfig } from "./create_worker";
