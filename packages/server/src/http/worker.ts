import { WorkerEntrypoint } from "cloudflare:workers";
import { createStreamWorker } from "./index";
import { StreamDO } from "./durable-object";
import { SubscriptionDO } from "../subscriptions/do";
import { EstuaryDO } from "../estuary/do";
import type { StreamIntrospection } from "./durable-object";
import type { BaseEnv } from "./index";

// Created at module scope so the in-flight coalescing Map is shared across
// all requests in the isolate (WorkerEntrypoint creates a new instance per
// request, so an instance field would give each request its own empty Map).
const handler = createStreamWorker();

export default class ServerWorker extends WorkerEntrypoint<BaseEnv> {
  // HTTP traffic delegates to existing factory
  async fetch(request: Request): Promise<Response> {
    return handler.fetch!(request as unknown as Request<unknown, IncomingRequestCfProperties>, this.env, this.ctx);
  }

  // Queue handler for async fanout
  async queue(batch: MessageBatch): Promise<void> {
    return handler.queue!(batch, this.env, this.ctx);
  }
}

export { ServerWorker, StreamDO, SubscriptionDO, EstuaryDO, createStreamWorker };
export type { StreamIntrospection } from "./durable-object";
export type { BaseEnv } from "./index";
export type { ProjectEntry, StreamEntry } from "../storage/registry";

