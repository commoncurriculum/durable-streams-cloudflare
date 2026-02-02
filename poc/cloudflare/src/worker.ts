import { StreamDO } from "./stream_do";

export interface Env {
  STREAMS: DurableObjectNamespace;
  DB: D1Database;
  AUTH_TOKEN?: string;
  R2?: R2Bucket;
}

const STREAM_PREFIX = "/v1/stream/";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith(STREAM_PREFIX)) {
      return new Response("not found", { status: 404 });
    }

    if (env.AUTH_TOKEN) {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${env.AUTH_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
    }

    const streamId = decodeURIComponent(url.pathname.slice(STREAM_PREFIX.length));
    if (!streamId) {
      return new Response("missing stream id", { status: 400 });
    }

    const id = env.STREAMS.idFromName(streamId);
    const stub = env.STREAMS.get(id);

    const headers = new Headers(request.headers);
    headers.set("X-Stream-Id", streamId);

    const upstreamReq = new Request(request, { headers });
    return stub.fetch(upstreamReq);
  },
};

export { StreamDO };
