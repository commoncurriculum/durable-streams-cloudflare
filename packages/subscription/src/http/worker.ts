import { createSubscriptionWorker } from "./create_worker";
import { bearerTokenAuth } from "./auth";
import { SubscriptionDO } from "../subscriptions/do";

export default createSubscriptionWorker({ authorize: bearerTokenAuth() });

export { SubscriptionDO, createSubscriptionWorker, bearerTokenAuth };
export type { SubscriptionAuthResult, SubscriptionRoute, AuthorizeSubscription } from "./auth";
export type { SubscriptionWorkerConfig } from "./create_worker";
