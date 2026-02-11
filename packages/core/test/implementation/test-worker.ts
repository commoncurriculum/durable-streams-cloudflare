import { WorkerEntrypoint } from "cloudflare:workers";
import { type } from "arktype";
import { createStreamWorker } from "../../src/http";
import { StreamDO } from "../../src/http/durable-object";
import type { BaseEnv } from "../../src/http";

const putStreamOptions = type({
  "expiresAt?": "number",
  "body?": "ArrayBuffer",
  "contentType?": "string",
});

// Created at module scope so the in-flight coalescing Map is shared across
// all requests in the isolate (WorkerEntrypoint creates a new instance per
// request, so an instance field would give each request its own empty Map).
const handler = createStreamWorker({ skipAuth: true });

// Auth-free worker for tests: skipAuth bypasses JWT auth middleware.
// Extends WorkerEntrypoint so subscription integration tests can use RPC methods.
export default class TestCoreWorker extends WorkerEntrypoint<BaseEnv> {
  async fetch(request: Request): Promise<Response> {
    // Route test-only debug actions via X-Debug-Action header to DO RPC methods
    const debugAction = request.headers.get("X-Debug-Action");
    if (debugAction) {
      return this.#handleDebugAction(debugAction, request);
    }

    return handler.fetch!(request as unknown as Request<unknown, IncomingRequestCfProperties>, this.env, this.ctx);
  }

  async #handleDebugAction(action: string, request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Extract stream ID from /v1/stream/:projectId/:streamId or /v1/stream/:streamId
    const pathMatch = /^\/v1\/stream\/(.+)$/.exec(url.pathname);
    if (!pathMatch) return new Response("not found", { status: 404 });
    const raw = pathMatch[1];
    const i = raw.indexOf("/");
    const doKey = i === -1
      ? `_default/${raw}`
      : `${raw.slice(0, i)}/${raw.slice(i + 1)}`;

    const streamId = doKey.split("/").slice(1).join("/");
    const stub = this.env.STREAMS.getByName(doKey);

    if (action === "compact-retain") {
      await stub.testForceCompact(streamId, true);
      return new Response(null, { status: 204 });
    }
    if (action === "compact") {
      await stub.testForceCompact(streamId, false);
      return new Response(null, { status: 204 });
    }
    if (action === "ops-count") {
      const count = await stub.testGetOpsCount(streamId);
      return new Response(JSON.stringify({ count }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (action === "producer-age") {
      const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
      if (!payload || typeof payload.producerId !== "string" || typeof payload.lastUpdated !== "number") {
        return new Response("invalid payload", { status: 400 });
      }
      const ok = await stub.testSetProducerAge(streamId, payload.producerId, payload.lastUpdated);
      return ok ? new Response(null, { status: 204 }) : new Response("not found", { status: 404 });
    }
    if (action === "rotate-reader-key") {
      const result = await this.rotateReaderKey(doKey);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (action === "truncate-latest") {
      const ok = await stub.testTruncateLatestSegment(streamId);
      return ok ? new Response(null, { status: 204 }) : new Response("failed", { status: 400 });
    }
    return new Response("unknown action", { status: 400 });
  }

  async rotateReaderKey(doKey: string): Promise<{ readerKey: string }> {
    const readerKey = `rk_${crypto.randomUUID().replace(/-/g, "")}`;
    const existing = await this.env.REGISTRY.get(doKey, "json") as Record<string, unknown> | null;
    await this.env.REGISTRY.put(doKey, JSON.stringify({ ...existing, readerKey }));
    return { readerKey };
  }

  async routeRequest(doKey: string, request: Request): Promise<Response> {
    const stub = this.env.STREAMS.getByName(doKey);
    return stub.routeStreamRequest(doKey, false, request);
  }

  async headStream(doKey: string): Promise<{ ok: boolean; status: number; body: string | null; contentType: string | null }> {
    const stub = this.env.STREAMS.getByName(doKey);
    const response = await stub.routeStreamRequest(
      doKey, false,
      new Request("https://internal/v1/stream", { method: "HEAD" }),
    );
    const body = response.ok ? null : await response.text();
    return { ok: response.ok, status: response.status, body, contentType: response.headers.get("Content-Type") };
  }

  async putStream(
    doKey: string,
    options: { expiresAt?: number; body?: ArrayBuffer; contentType?: string },
  ): Promise<{ ok: boolean; status: number; body: string | null }> {
    const validated = putStreamOptions(options);
    if (validated instanceof type.errors) {
      return { ok: false, status: 400, body: validated.summary };
    }
    const headers: Record<string, string> = {};
    if (options.contentType) {
      headers["Content-Type"] = options.contentType;
    }
    if (options.expiresAt) {
      headers["Stream-Expires-At"] = new Date(options.expiresAt).toISOString();
    }
    const stub = this.env.STREAMS.getByName(doKey);
    const response = await stub.routeStreamRequest(
      doKey, false,
      new Request("https://internal/v1/stream", {
        method: "PUT",
        headers,
        body: options.body,
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
