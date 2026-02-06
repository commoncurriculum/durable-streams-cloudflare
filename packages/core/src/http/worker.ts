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
    return stub.routeStreamRequest(doKey, false, request);
  }

  // RPC: check if a stream exists
  async headStream(doKey: string): Promise<{ ok: boolean; status: number }> {
    const stub = this.env.STREAMS.getByName(doKey);
    const response = await stub.routeStreamRequest(
      doKey, false,
      new Request("https://internal/v1/stream", { method: "HEAD" }),
    );
    return { ok: response.ok, status: response.status };
  }

  // RPC: create or touch a stream
  async putStream(doKey: string, options?: { expiresAt?: number }): Promise<{ ok: boolean; status: number }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options?.expiresAt) {
      headers["X-Stream-Expires-At"] = options.expiresAt.toString();
    }
    const stub = this.env.STREAMS.getByName(doKey);
    const response = await stub.routeStreamRequest(
      doKey, false,
      new Request("https://internal/v1/stream", { method: "PUT", headers }),
    );
    return { ok: response.ok, status: response.status };
  }

  // RPC: delete a stream
  async deleteStream(doKey: string): Promise<{ ok: boolean; status: number }> {
    const stub = this.env.STREAMS.getByName(doKey);
    const response = await stub.routeStreamRequest(
      doKey, false,
      new Request("https://internal/v1/stream", { method: "DELETE" }),
    );
    return { ok: response.ok, status: response.status };
  }

  // RPC: append to a stream (POST)
  async postStream(
    doKey: string,
    payload: ArrayBuffer,
    contentType: string,
    producerHeaders?: { producerId: string; producerEpoch: string; producerSeq: string },
  ): Promise<{ ok: boolean; status: number; nextOffset: string | null; body: string | null }> {
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (producerHeaders) {
      headers["Producer-Id"] = producerHeaders.producerId;
      headers["Producer-Epoch"] = producerHeaders.producerEpoch;
      headers["Producer-Seq"] = producerHeaders.producerSeq;
    }
    const stub = this.env.STREAMS.getByName(doKey);
    const response = await stub.routeStreamRequest(
      doKey, false,
      new Request("https://internal/v1/stream", { method: "POST", headers, body: payload }),
    );
    const body = response.ok ? null : await response.text();
    return {
      ok: response.ok,
      status: response.status,
      nextOffset: response.headers.get("X-Stream-Next-Offset"),
      body,
    };
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
