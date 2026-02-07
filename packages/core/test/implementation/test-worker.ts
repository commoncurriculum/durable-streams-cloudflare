import { WorkerEntrypoint } from "cloudflare:workers";
import { type } from "arktype";
import { createStreamWorker } from "../../src/http/create_worker";
import { StreamDO } from "../../src/http/durable_object";
import type { BaseEnv } from "../../src/http/create_worker";

const putStreamOptions = type({
  "expiresAt?": "number",
  "body?": "ArrayBuffer",
  "contentType?": "string",
});

// Auth-free worker for tests: no auth callbacks = no auth checks.
// Extends WorkerEntrypoint so subscription integration tests can use RPC methods.
export default class TestCoreWorker extends WorkerEntrypoint<BaseEnv> {
  #handler = createStreamWorker();

  async fetch(request: Request): Promise<Response> {
    return this.#handler.fetch!(request as unknown as Request<unknown, IncomingRequestCfProperties>, this.env, this.ctx);
  }

  async headStream(doKey: string): Promise<{ ok: boolean; status: number; body: string | null }> {
    const stub = this.env.STREAMS.getByName(doKey);
    const response = await stub.routeStreamRequest(
      doKey, false,
      new Request("https://internal/v1/stream", { method: "HEAD" }),
    );
    const body = response.ok ? null : await response.text();
    return { ok: response.ok, status: response.status, body };
  }

  async putStream(
    doKey: string,
    options?: { expiresAt?: number; body?: ArrayBuffer; contentType?: string },
  ): Promise<{ ok: boolean; status: number; body: string | null }> {
    if (options) {
      const validated = putStreamOptions(options);
      if (validated instanceof type.errors) {
        return { ok: false, status: 400, body: validated.summary };
      }
    }
    const headers: Record<string, string> = {
      "Content-Type": options?.contentType ?? "application/json",
    };
    if (options?.expiresAt) {
      headers["Stream-Expires-At"] = new Date(options.expiresAt).toISOString();
    }
    const stub = this.env.STREAMS.getByName(doKey);
    const response = await stub.routeStreamRequest(
      doKey, false,
      new Request("https://internal/v1/stream", {
        method: "PUT",
        headers,
        body: options?.body,
      }),
    );
    const body = response.ok ? null : await response.text();
    return { ok: response.ok, status: response.status, body };
  }

  async deleteStream(doKey: string): Promise<{ ok: boolean; status: number; body: string | null }> {
    const stub = this.env.STREAMS.getByName(doKey);
    const response = await stub.routeStreamRequest(
      doKey, false,
      new Request("https://internal/v1/stream", { method: "DELETE" }),
    );
    const body = response.ok ? null : await response.text();
    return { ok: response.ok, status: response.status, body };
  }

  async postStream(
    doKey: string,
    payload: ArrayBuffer,
    contentType: string,
    producerHeaders?: { producerId: string; producerEpoch: string; producerSeq: string },
  ): Promise<{ ok: boolean; status: number; nextOffset: string | null; upToDate: string | null; streamClosed: string | null; body: string | null }> {
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
      nextOffset: response.headers.get("Stream-Next-Offset"),
      upToDate: response.headers.get("Stream-Up-To-Date"),
      streamClosed: response.headers.get("Stream-Closed"),
      body,
    };
  }
}

export { StreamDO };
