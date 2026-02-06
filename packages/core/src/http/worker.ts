import { WorkerEntrypoint } from "cloudflare:workers";
import { createStreamWorker } from "./create_worker";
import { projectKeyMutationAuth, projectKeyReadAuth } from "./auth";
import { resolveCacheMode } from "./router";
import { StreamDO } from "./durable_object";
import type { StreamIntrospection } from "./durable_object";
import type { BaseEnv } from "./create_worker";

export default class CoreWorker extends WorkerEntrypoint<BaseEnv> {
  #handler = createStreamWorker({
    authorizeMutation: projectKeyMutationAuth(),
    authorizeRead: projectKeyReadAuth(),
  });

  // HTTP traffic delegates to existing factory (external callers, unchanged)
  async fetch(request: Request): Promise<Response> {
    return this.#handler.fetch!(request as unknown as Request<unknown, IncomingRequestCfProperties>, this.env, this.ctx);
  }

  // RPC: stream inspection (replaces /admin HTTP endpoint)
  async inspectStream(doKey: string): Promise<StreamIntrospection | null> {
    const stub = this.env.STREAMS.getByName(doKey);
    return stub.getIntrospection(doKey);
  }

  // RPC: route any stream request without auth (reads, writes, SSE)
  async routeRequest(doKey: string, request: Request): Promise<Response> {
    const stub = this.env.STREAMS.getByName(doKey);
    const cacheMode = resolveCacheMode({ envMode: this.env.CACHE_MODE });
    return stub.routeStreamRequest(doKey, cacheMode, null, false, request);
  }
}

export { CoreWorker, StreamDO, createStreamWorker };
export {
  bearerTokenAuth,
  jwtStreamAuth,
  projectKeyMutationAuth,
  projectKeyReadAuth,
} from "./auth";
export type { StreamIntrospection } from "./durable_object";
export type {
  AuthResult,
  ReadAuthResult,
  AuthorizeMutation,
  AuthorizeRead,
  ProjectKeyEnv,
} from "./auth";
export type { BaseEnv, StreamWorkerConfig } from "./create_worker";
