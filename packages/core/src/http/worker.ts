import { WorkerEntrypoint } from "cloudflare:workers";
import { createStreamWorker } from "./create_worker";
import { projectJwtAuth } from "./auth";
import { StreamDO } from "./durable_object";
import type { StreamIntrospection } from "./durable_object";
import type { BaseEnv } from "./create_worker";

const { authorizeMutation, authorizeRead } = projectJwtAuth();

export default class CoreWorker extends WorkerEntrypoint<BaseEnv> {
  #handler = createStreamWorker({
    authorizeMutation,
    authorizeRead,
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
    return stub.routeStreamRequest(doKey, null, false, request);
  }
}

export { CoreWorker, StreamDO, createStreamWorker };
export { projectJwtAuth, extractBearerToken } from "./auth";
export type { StreamIntrospection } from "./durable_object";
export type {
  AuthResult,
  ReadAuthResult,
  AuthorizeMutation,
  AuthorizeRead,
  ProjectJwtEnv,
  ProjectJwtClaims,
} from "./auth";
export type { BaseEnv, StreamWorkerConfig } from "./create_worker";
