import { WorkerEntrypoint } from "cloudflare:workers";
import { createStreamWorker } from "../../src/http/create_worker";
import { StreamDO } from "../../src/http/durable_object";
import type { BaseEnv } from "../../src/http/create_worker";

// Auth-enabled worker for reader key tests: uses a permissive auth callback
// that always passes. This ensures authorizeRead is set so reader keys are
// generated on stream creation, while still allowing all requests through.
const handler = createStreamWorker({
  authorizeRead: () => ({ ok: true }),
  authorizeMutation: () => ({ ok: true }),
});

export default class TestCoreWorkerAuth extends WorkerEntrypoint<BaseEnv> {
  async fetch(request: Request): Promise<Response> {
    const debugAction = request.headers.get("X-Debug-Action");
    if (debugAction) {
      return this.#handleDebugAction(debugAction, request);
    }

    return handler.fetch!(request as unknown as Request<unknown, IncomingRequestCfProperties>, this.env, this.ctx);
  }

  async #handleDebugAction(action: string, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathMatch = /^\/v1\/stream\/(.+)$/.exec(url.pathname);
    if (!pathMatch) return new Response("not found", { status: 404 });
    const raw = pathMatch[1];
    const i = raw.indexOf("/");
    const doKey = i === -1
      ? `_default/${raw}`
      : `${raw.slice(0, i)}/${raw.slice(i + 1)}`;

    if (action === "rotate-reader-key") {
      const result = await this.rotateReaderKey(doKey);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unknown action", { status: 400 });
  }

  async rotateReaderKey(doKey: string): Promise<{ readerKey: string }> {
    const readerKey = `rk_${crypto.randomUUID().replace(/-/g, "")}`;
    const existing = await this.env.REGISTRY.get(doKey, "json") as Record<string, unknown> | null;
    await this.env.REGISTRY.put(doKey, JSON.stringify({ ...existing, readerKey }));
    return { readerKey };
  }
}

export { StreamDO };
