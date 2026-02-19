import { WorkerEntrypoint } from "cloudflare:workers";
import { createStreamWorker } from "./router";
import { StreamDO } from "./v1/streams";
import { StreamSubscribersDO, EstuaryDO } from "./v1/estuary";
import type { BaseEnv } from "./router";

// Created at module scope so the in-flight coalescing Map is shared across
// all requests in the isolate (WorkerEntrypoint creates a new instance per
// request, so an instance field would give each request its own empty Map).
const handler = createStreamWorker();

export default class ServerWorker extends WorkerEntrypoint<BaseEnv> {
  // HTTP traffic delegates to existing factory
  async fetch(request: Request): Promise<Response> {
    return handler.fetch!(
      request as unknown as Request<unknown, IncomingRequestCfProperties>,
      this.env,
      this.ctx,
    );
  }

  // Queue handler for async fanout
  async queue(batch: MessageBatch): Promise<void> {
    return handler.queue!(batch, this.env, this.ctx);
  }
}

export { 
  ServerWorker, 
  StreamDO, 
  StreamSubscribersDO, 
  StreamSubscribersDO as SubscriptionDO,  // Alias for wrangler.toml compatibility
  EstuaryDO, 
  createStreamWorker 
};
export type { BaseEnv } from "./router";
export type { ProjectEntry, StreamEntry } from "../storage/registry";
