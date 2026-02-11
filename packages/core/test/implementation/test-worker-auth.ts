import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import { StreamDO } from "../../src/http/durable-object";
import type { BaseEnv } from "../../src/http";
import type { InFlightResult } from "../../src/http/middleware/coalesce";
import { HEADER_STREAM_READER_KEY } from "../../src/http/shared/headers";
import { pathParsingMiddleware } from "../../src/http/middleware/path-parsing";
import { corsMiddleware } from "../../src/http/middleware/cors";
import { timingMiddleware } from "../../src/http/middleware/timing";
import { createEdgeCacheMiddleware } from "../../src/http/middleware/edge-cache";
import { getStreamEntry } from "../../src/storage/registry";
import { errorResponse } from "../../src/http/shared/errors";
import { logError } from "../../src/log";

// Build a Hono app for reader key tests. No JWT auth, but includes a
// streamMeta lookup middleware so that:
// - PUT 201 generates reader keys via edge-cache's writeStreamCreationMetadata
// - HEAD returns Stream-Reader-Key via the streamMeta middleware below
// - GET ?rk cache behaviour works correctly
//
// This is test-only code — the production createStreamWorker() always has full auth.
const inFlight = new Map<string, Promise<InFlightResult>>();
const app = new Hono();

app.use("*", pathParsingMiddleware);
app.use("*", corsMiddleware);
// No authenticationMiddleware / authorizationMiddleware

// Stream-scoped: streamMeta lookup + reader key on HEAD (same as authorizationMiddleware
// does in production, but without the JWT enforcement)
// biome-ignore lint: Hono context typing is complex
app.use("/v1/stream/*", async (c: any, next: () => Promise<void>) => {
  const doKey = c.get("streamPath");
  const method = c.req.method.toUpperCase();

  let streamMeta = null;
  if ((method === "GET" || method === "HEAD") && doKey && c.env.REGISTRY) {
    const entry = await getStreamEntry(c.env.REGISTRY, doKey);
    if (entry) streamMeta = { public: entry.public, readerKey: entry.readerKey };
  }
  c.set("streamMeta", streamMeta);

  await next();

  if (method === "HEAD" && c.res?.ok && streamMeta?.readerKey) {
    c.res.headers.set(HEADER_STREAM_READER_KEY, streamMeta.readerKey);
  }
});

app.use("/v1/stream/*", timingMiddleware);
app.use("/v1/stream/*", createEdgeCacheMiddleware(inFlight));

// biome-ignore lint: Hono context typing is complex
app.get("/health", (c: any) => c.text("ok", 200, { "Cache-Control": "no-store" }));

// biome-ignore lint: Hono context typing is complex
app.all("/v1/stream/*", async (c: any) => {
  const timing = c.get("timing");
  const doKey = c.get("streamPath");
  const stub = c.env.STREAMS.getByName(doKey);
  const doneOrigin = timing?.start("edge.origin");
  const response = await stub.routeStreamRequest(doKey, !!timing, c.req.raw);
  doneOrigin?.();
  return response;
});

// biome-ignore lint: Hono context typing is complex
app.all("*", (c: any) => c.text("not found", 404, { "Cache-Control": "no-store" }));

// biome-ignore lint: Hono context typing is complex
app.onError((err: Error, c: any) => {
  logError({ streamPath: c.get("streamPath"), method: c.req.method }, "unhandled error", err);
  return errorResponse(500, err.message ?? "internal error");
});

const handler = { fetch: app.fetch };

export default class TestCoreWorkerAuth extends WorkerEntrypoint<BaseEnv> {
  async fetch(request: Request): Promise<Response> {
    const debugAction = request.headers.get("X-Debug-Action");
    if (debugAction) {
      return this.#handleDebugAction(debugAction, request);
    }
    return handler.fetch(request as unknown as Request<unknown, IncomingRequestCfProperties>, this.env, this.ctx);
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
